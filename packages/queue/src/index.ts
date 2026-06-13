import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
export const CRAWL_QUEUE = "crawl";

export interface CrawlJob {
  runId: string;
  url: string;
  baseUrl: string;
  /** Follow internal links found on this page. Default true (omitted = true). */
  follow?: boolean;
  /** Restrict discovered links to these languages (lowercased). Empty/absent = all. */
  langs?: string[];
}

let _connection: Redis | undefined;
/** Long-lived connection shared by the queue and workers (lazy). */
export function connection(): Redis {
  if (!_connection) {
    _connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return _connection;
}

let _queue: Queue<CrawlJob, unknown, string> | undefined;
export function crawlQueue(): Queue<CrawlJob, unknown, string> {
  if (!_queue) {
    _queue = new Queue<CrawlJob, unknown, string>(CRAWL_QUEUE, { connection: connection() });
  }
  return _queue;
}

/** Per-run Redis keys for dedup, completion tracking, and limits. */
export const keys = {
  seen: (runId: string) => `lc:seen:${runId}`,
  pending: (runId: string) => `lc:pending:${runId}`,
  crawled: (runId: string) => `lc:crawled:${runId}`,
  max: (runId: string) => `lc:max:${runId}`,
  done: (runId: string) => `lc:done:${runId}`,
  /** Full set of URLs a sitemap advertised — read once at finalize for the audit. */
  sitemap: (runId: string) => `lc:sitemap:${runId}`,
};

/** Quick liveness check — is Redis actually reachable right now? */
export async function pingRedis(timeoutMs = 1500): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: timeoutMs,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  // Swallow connection errors — an unhandled 'error' event would crash the process.
  probe.on("error", () => {});
  try {
    await probe.connect();
    const pong = await probe.ping();
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

export interface EnqueueSeedOptions {
  /**
   * When these are a sitemap's URLs, the FULL listed set is stored for the
   * post-run audit (dead-URL + truncation check) before `max` capping is
   * applied to what actually gets crawled.
   */
  sitemapUrls?: string[];
  /** Follow internal links from seed pages. Default true; false = crawl only the seeds. */
  follow?: boolean;
  /** Restrict discovered links to these languages (lowercased). Stored on each job. */
  langs?: string[];
}

/**
 * Seed a run into the queue: register the page limit, mark seed URLs as seen,
 * set the pending-job counter, then enqueue. Counter is set BEFORE enqueuing so
 * a fast worker can't drive it to zero prematurely.
 *
 * Seeds are capped at `max` so a huge sitemap behaves the same here as in the
 * in-process crawler (both treat `max` as a hard page budget). The uncapped
 * count is returned as `total` so the caller can warn about truncation.
 */
export async function enqueueSeed(
  runId: string,
  urls: string[],
  baseUrl: string,
  max: number,
  opts: EnqueueSeedOptions = {},
): Promise<{ enqueued: number; total: number }> {
  const c = connection();
  const q = crawlQueue();

  // Persist the full sitemap set (in chunks) for the finalize-time audit.
  if (opts.sitemapUrls && opts.sitemapUrls.length > 0) {
    for (let i = 0; i < opts.sitemapUrls.length; i += 1000) {
      await c.sadd(keys.sitemap(runId), ...opts.sitemapUrls.slice(i, i + 1000));
    }
    await c.expire(keys.sitemap(runId), 86_400);
  }

  const capped = Number.isFinite(max) ? urls.slice(0, max) : urls;
  const fresh: string[] = [];
  for (const url of capped) {
    if ((await c.sadd(keys.seen(runId), url)) === 1) fresh.push(url);
  }

  await c.set(keys.max(runId), String(max));
  await c.set(keys.crawled(runId), "0");
  await c.set(keys.pending(runId), String(fresh.length));

  const follow = opts.follow ?? true;
  const langs = opts.langs && opts.langs.length > 0 ? opts.langs : undefined;
  for (const url of fresh) {
    await q.add(
      "crawl",
      { runId, url, baseUrl, follow, langs },
      { removeOnComplete: true, removeOnFail: 1000 },
    );
  }
  return { enqueued: fresh.length, total: urls.length };
}

/** Read the stored sitemap URL set for a run (empty if not a sitemap crawl). */
export async function getSitemapUrls(runId: string): Promise<string[]> {
  return connection().smembers(keys.sitemap(runId));
}

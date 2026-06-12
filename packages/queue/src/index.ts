import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
export const CRAWL_QUEUE = "crawl";

export interface CrawlJob {
  runId: string;
  url: string;
  baseUrl: string;
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

/**
 * Seed a run into the queue: register the page limit, mark seed URLs as seen,
 * set the pending-job counter, then enqueue. Counter is set BEFORE enqueuing so
 * a fast worker can't drive it to zero prematurely.
 */
export async function enqueueSeed(
  runId: string,
  urls: string[],
  baseUrl: string,
  max: number,
): Promise<number> {
  const c = connection();
  const q = crawlQueue();

  const fresh: string[] = [];
  for (const url of urls) {
    if ((await c.sadd(keys.seen(runId), url)) === 1) fresh.push(url);
  }

  await c.set(keys.max(runId), String(max));
  await c.set(keys.crawled(runId), "0");
  await c.set(keys.pending(runId), String(fresh.length));

  for (const url of fresh) {
    await q.add("crawl", { runId, url, baseUrl }, { removeOnComplete: true, removeOnFail: 1000 });
  }
  return fresh.length;
}

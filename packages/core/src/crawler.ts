import { fetchPage, isHtmlType, type FetchOptions } from "./fetcher.js";
import { RobotsGate } from "./robots.js";
import { StatusChecker } from "./status-checker.js";
import { hostOf, Throttle } from "./throttle.js";
import { isInternalUrl, normalizeUrl } from "./url.js";
import type { Analyzer, AnalyzerResult, CrawlContext, FetchedPage } from "./types.js";

/**
 * Fetch one page and run every analyzer over it. Shared by both the in-process
 * crawler ({@link runCrawl}) and the distributed BullMQ worker, so the
 * fetch+analyze logic lives in exactly one place. When a {@link Throttle} is
 * passed, the page fetch is rate-limited per host.
 */
export async function processPage(
  url: string,
  analyzers: Analyzer[],
  ctx: CrawlContext,
  fetchOptions: FetchOptions = {},
  throttle?: Throttle,
): Promise<{ page: FetchedPage; results: Array<{ analyzer: string; result: AnalyzerResult }> }> {
  const page = throttle
    ? await throttle.run(hostOf(url), () => fetchPage(url, fetchOptions))
    : await fetchPage(url, fetchOptions);
  const results: Array<{ analyzer: string; result: AnalyzerResult }> = [];
  if (page.ok && isHtmlType(page.contentType)) {
    for (const analyzer of analyzers) {
      try {
        results.push({ analyzer: analyzer.name, result: await analyzer.analyze(page, ctx) });
      } catch {
        // A misbehaving analyzer must not abort the crawl.
      }
    }
  }
  return { page, results };
}

export interface CrawlHooks {
  onPage?(page: FetchedPage): void | Promise<void>;
  onResult?(page: FetchedPage, result: AnalyzerResult, analyzer: string): void | Promise<void>;
}

export interface PolitenessConfig {
  /** Max concurrent requests to the same host (default 3). */
  perHostConcurrency?: number;
  /** Minimum delay between requests to the same host, ms (default 100). */
  minHostDelayMs?: number;
  /** Respect robots.txt (disallow rules + Crawl-delay). Default true. */
  respectRobots?: boolean;
  /** Token presented to robots.txt for group matching. */
  robotsUserAgent?: string;
}

export interface CrawlConfig {
  startUrls: string[];
  /** Defaults to the first start URL — defines what counts as "internal". */
  baseUrl?: string;
  analyzers: Analyzer[];
  concurrency?: number;
  maxPages?: number;
  fetchOptions?: FetchOptions;
  politeness?: PolitenessConfig;
  hooks?: CrawlHooks;
}

export interface CrawlStats {
  pages: number;
  findings: number;
  /** Pages skipped because robots.txt disallowed them. */
  skipped: number;
}

/**
 * In-process crawler with a bounded worker pool. Great for development, small
 * sites, and single-machine runs. For 100k+ URLs across machines, use the
 * BullMQ worker (apps/worker) which reuses {@link processPage}.
 */
export async function runCrawl(config: CrawlConfig): Promise<CrawlStats> {
  const {
    startUrls,
    analyzers,
    concurrency = 10,
    maxPages = Number.POSITIVE_INFINITY,
    fetchOptions = {},
    hooks = {},
  } = config;

  const base = new URL(config.baseUrl ?? startUrls[0]!);
  const pol = config.politeness ?? {};
  const throttle = new Throttle({
    perHostConcurrency: pol.perHostConcurrency,
    minHostDelayMs: pol.minHostDelayMs,
  });
  const robots =
    pol.respectRobots === false
      ? null
      : new RobotsGate({ userAgent: pol.robotsUserAgent, fetch: fetchOptions });
  const statusChecker = new StatusChecker(fetchOptions, throttle);
  const ctx: CrawlContext = {
    baseUrl: base.toString(),
    isInternal: (u) => isInternalUrl(u, base),
    checkStatus: (u) => statusChecker.check(u),
  };

  const seen = new Set<string>();
  const queue: string[] = [];
  const stats: CrawlStats = { pages: 0, findings: 0, skipped: 0 };

  const enqueue = (raw: string): void => {
    const n = normalizeUrl(raw, base.toString());
    if (!n || seen.has(n)) return;
    seen.add(n);
    queue.push(n);
  };
  for (const u of startUrls) enqueue(u);

  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (active < concurrency && queue.length > 0 && stats.pages < maxPages) {
        const url = queue.shift()!;
        active++;
        void processUrl(url).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0 && (queue.length === 0 || stats.pages >= maxPages)) {
        resolve();
      }
    };
    pump();
  });

  return stats;

  async function processUrl(url: string): Promise<void> {
    if (robots) {
      const rules = await robots.get(url);
      if (rules.crawlDelay && rules.crawlDelay > 0) {
        throttle.setHostDelay(hostOf(url), rules.crawlDelay * 1000);
      }
      if (!rules.isAllowed(url)) {
        stats.skipped++;
        return;
      }
    }
    const { page, results } = await processPage(url, analyzers, ctx, fetchOptions, throttle);
    stats.pages++;
    await hooks.onPage?.(page);
    for (const { analyzer, result } of results) {
      stats.findings += result.findings.length;
      await hooks.onResult?.(page, result, analyzer);
      for (const next of result.discoveredUrls) {
        if (ctx.isInternal(next)) enqueue(next);
      }
    }
  }
}

import "dotenv/config";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  hostOf,
  isInternalUrl,
  normalizeUrl,
  processPage,
  RobotsGate,
  StatusChecker,
  Throttle,
  type CrawlContext,
} from "@linkchecker/core";
import { LinkChecker } from "@linkchecker/analyzers";
import { createSink } from "@linkchecker/db";
import { connection, CRAWL_QUEUE, crawlQueue, REDIS_URL, seenKey, type CrawlJob } from "./queue.js";

/**
 * Distributed crawler. Each job = one page. Run many of these processes (even
 * across machines); they share the frontier via Redis. Discovered internal
 * URLs are deduped with an atomic SADD before being enqueued, so the same page
 * is never crawled twice. Seed a run with `npm run seed`.
 */
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const analyzers = [new LinkChecker()];

// Shared across all jobs in this process → per-host limits hold even when many
// jobs for the same host run concurrently.
const throttle = new Throttle();
const robots = new RobotsGate();

const worker = new Worker<CrawlJob, unknown, string>(
  CRAWL_QUEUE,
  async (job) => {
    const { runId, url, baseUrl } = job.data;
    const base = new URL(baseUrl);
    const statusChecker = new StatusChecker({}, throttle);
    const ctx: CrawlContext = {
      baseUrl: base.toString(),
      isInternal: (u) => isInternalUrl(u, base),
      checkStatus: (u) => statusChecker.check(u),
      runId,
    };
    const sink = createSink(runId);

    // Respect robots.txt (Crawl-delay + disallow) before fetching.
    const rules = await robots.get(url);
    if (rules.crawlDelay && rules.crawlDelay > 0) {
      throttle.setHostDelay(hostOf(url), rules.crawlDelay * 1000);
    }
    if (!rules.isAllowed(url)) {
      return { url, skipped: true };
    }

    const { page, results } = await processPage(url, analyzers, ctx, {}, throttle);
    await sink.page(page);

    for (const { result } of results) {
      await sink.result(page, result);
      for (const next of result.discoveredUrls) {
        if (!ctx.isInternal(next)) continue;
        const n = normalizeUrl(next, base.toString());
        if (!n) continue;
        // SADD returns 1 only the first time this URL is seen in the run.
        const isNew = await redis.sadd(seenKey(runId), n);
        if (isNew === 1) {
          await crawlQueue.add(
            "crawl",
            { runId, url: n, baseUrl },
            { removeOnComplete: true, removeOnFail: 1000 },
          );
        }
      }
    }
    return { url, findings: results.reduce((s, r) => s + r.result.findings.length, 0) };
  },
  { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10) },
);

worker.on("completed", (job) => {
  console.log(`  ✓ ${job.data.url}`);
});
worker.on("failed", (job, err) => {
  console.error(`  ✗ ${job?.data.url}: ${err.message}`);
});

console.log(`Worker listening on "${CRAWL_QUEUE}" (concurrency ${worker.opts.concurrency}).`);

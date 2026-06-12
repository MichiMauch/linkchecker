import "dotenv/config";
import { Worker } from "bullmq";
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
import { defaultAnalyzers } from "@linkchecker/analyzers";
import { createSink, finalizeRun } from "@linkchecker/db";
import {
  connection,
  crawlQueue,
  CRAWL_QUEUE,
  keys,
  type CrawlJob,
} from "@linkchecker/queue";

/**
 * Distributed crawler. Each job = one page. Run many of these processes (even
 * across machines); they share the frontier and a per-run completion counter
 * via Redis, so the run is marked "done" exactly once when the queue drains.
 * Seed a run from the dashboard (USE_WORKER=true) or with `npm run seed`.
 */
const redis = connection();
const queue = crawlQueue();
const analyzers = defaultAnalyzers();

// Shared across all jobs in this process so per-host limits hold even when many
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

    try {
      // robots.txt: skip disallowed pages, honor Crawl-delay.
      const rules = await robots.get(url);
      if (rules.crawlDelay && rules.crawlDelay > 0) {
        throttle.setHostDelay(hostOf(url), rules.crawlDelay * 1000);
      }
      if (!rules.isAllowed(url)) return { url, skipped: true };

      const { page, results } = await processPage(url, analyzers, ctx, {}, throttle);
      await sink.page(page);
      await redis.incr(keys.crawled(runId));

      const max = Number((await redis.get(keys.max(runId))) ?? Number.POSITIVE_INFINITY);
      const crawled = Number((await redis.get(keys.crawled(runId))) ?? 0);

      let childrenAdded = 0;
      if (crawled < max) {
        for (const { result } of results) {
          await sink.result(page, result);
          for (const next of result.discoveredUrls) {
            if (!ctx.isInternal(next)) continue;
            const n = normalizeUrl(next, base.toString());
            if (!n) continue;
            if ((await redis.sadd(keys.seen(runId), n)) === 1) {
              await queue.add(
                "crawl",
                { runId, url: n, baseUrl },
                { removeOnComplete: true, removeOnFail: 1000 },
              );
              childrenAdded++;
            }
          }
        }
      } else {
        // At the page limit: still persist findings, just don't expand further.
        for (const { result } of results) await sink.result(page, result);
      }

      if (childrenAdded > 0) await redis.incrby(keys.pending(runId), childrenAdded);
      return { url, findings: results.reduce((s, r) => s + r.result.findings.length, 0) };
    } finally {
      // This job is done — decrement and, if the run drained, finalize once.
      const remaining = await redis.decr(keys.pending(runId));
      if (remaining <= 0 && (await redis.setnx(keys.done(runId), "1")) === 1) {
        await finalizeRun(runId);
        await redis.del(keys.seen(runId), keys.pending(runId), keys.crawled(runId), keys.max(runId));
        await redis.expire(keys.done(runId), 3600);
        console.log(`✓ run ${runId} complete`);
      }
    }
  },
  { connection: redis, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10) },
);

worker.on("failed", (job, err) => {
  console.error(`  ✗ ${job?.data.url}: ${err.message}`);
});

console.log(`Worker listening on "${CRAWL_QUEUE}" (concurrency ${worker.opts.concurrency}).`);

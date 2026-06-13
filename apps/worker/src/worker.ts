import "dotenv/config";
import { Worker } from "bullmq";
import {
  AnchorChecker,
  hostOf,
  isInternalUrl,
  langAllowed,
  normalizeUrl,
  processPage,
  RobotsGate,
  StatusChecker,
  Throttle,
  type CrawlContext,
} from "@linkchecker/core";
import { defaultAnalyzers } from "@linkchecker/analyzers";
import { auditSitemap, createSink, finalizeRun, verifyRunBrokenLinks } from "@linkchecker/db";
import {
  connection,
  crawlQueue,
  CRAWL_QUEUE,
  getSitemapUrls,
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
// jobs for the same host run concurrently. The anchor cache is shared too, so
// a fragment target fetched for one page is reused for the next.
const throttle = new Throttle();
const robots = new RobotsGate();
const anchorChecker = new AnchorChecker({}, throttle);

const worker = new Worker<CrawlJob, unknown, string>(
  CRAWL_QUEUE,
  async (job) => {
    const { runId, url, baseUrl, follow = true, langs } = job.data;
    const base = new URL(baseUrl);
    const langSet = langs && langs.length > 0 ? new Set(langs) : null;
    const statusChecker = new StatusChecker({}, throttle);
    const ctx: CrawlContext = {
      baseUrl: base.toString(),
      isInternal: (u) => isInternalUrl(u, base),
      checkStatus: (u) => statusChecker.check(u),
      getAnchors: (u) => anchorChecker.get(u),
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
      if (follow && crawled < max) {
        for (const { result } of results) {
          await sink.result(page, result);
          for (const next of result.discoveredUrls) {
            if (!ctx.isInternal(next)) continue;
            const n = normalizeUrl(next, base.toString());
            if (!n || !langAllowed(n, langSet)) continue;
            if ((await redis.sadd(keys.seen(runId), n)) === 1) {
              await queue.add(
                "crawl",
                { runId, url: n, baseUrl, follow, langs },
                { removeOnComplete: true, removeOnFail: 1000 },
              );
              childrenAdded++;
            }
          }
        }
      } else {
        // Seeds-only mode or at the page limit: persist findings, don't expand.
        for (const { result } of results) await sink.result(page, result);
      }

      if (childrenAdded > 0) await redis.incrby(keys.pending(runId), childrenAdded);
      return { url, findings: results.reduce((s, r) => s + r.result.findings.length, 0) };
    } finally {
      // This job is done — decrement and, if the run drained, finalize once.
      const remaining = await redis.decr(keys.pending(runId));
      if (remaining <= 0 && (await redis.setnx(keys.done(runId), "1")) === 1) {
        // Re-confirm every claimed-broken link once, fresh, before finalizing —
        // transient timeouts/5xx that recovered are dropped here.
        const verified = await verifyRunBrokenLinks(runId);
        if (verified.cleared > 0) {
          console.log(
            `↻ run ${runId}: verify-pass cleared ${verified.cleared}/${verified.rechecked} transient broken links`,
          );
        }
        // Sitemap audit: dead listed URLs + truncation, using the stored set.
        const sitemapUrls = await getSitemapUrls(runId);
        if (sitemapUrls.length > 0) {
          const cap = Number((await redis.get(keys.max(runId))) ?? Number.POSITIVE_INFINITY);
          const audit = await auditSitemap(runId, sitemapUrls, { cap, baseUrl });
          if (audit.dead > 0 || audit.truncated) {
            console.log(
              `🗺  run ${runId}: ${audit.dead} tote Sitemap-URLs${audit.truncated ? ", Sitemap gekappt (max erhöhen)" : ""}`,
            );
          }
        }
        await finalizeRun(runId);
        await redis.del(
          keys.seen(runId),
          keys.pending(runId),
          keys.crawled(runId),
          keys.max(runId),
          keys.sitemap(runId),
        );
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

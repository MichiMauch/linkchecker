import "dotenv/config";
import { fetchSitemapUrls, langAllowed, normalizeUrl, runCrawl, type CrawlHooks } from "@linkchecker/core";
import { defaultAnalyzers } from "@linkchecker/analyzers";
import { describeSubset, parseArgs } from "./args.js";

/**
 * Standalone, single-process crawl. No Redis required. Persists to Postgres
 * unless --no-db is passed (console-only, handy for a quick smoke test).
 *
 *   npm run crawl -- --url https://example.com --max 200
 *   npm run crawl -- --sitemap https://example.com/sitemap.xml
 *   npm run crawl -- --url https://example.com --no-db   # console only
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const sitemapOpts = {
    ...(args.dateRange ? { filter: args.dateRange } : {}),
    ...(args.select ? { select: args.select } : {}),
  };
  const rawSeeds = args.sitemap ? await fetchSitemapUrls(args.sitemap, sitemapOpts) : [args.url!];
  const baseUrl = args.base ?? rawSeeds[0]!;
  // Normalize up front so the audit's URL set matches what lands in `pages`.
  const langSet = args.langs && args.langs.length > 0 ? new Set(args.langs) : null;
  const startUrls = rawSeeds
    .map((u) => normalizeUrl(u, baseUrl))
    .filter((u): u is string => !!u && langAllowed(u, langSet));

  // A sitemap subset ("newest 100", date window) = check exactly those, no following.
  const isSubset = !!(args.select || args.dateRange);
  const followLinks = !isSubset;
  const maxPages = isSubset ? startUrls.length : args.max;

  if (isSubset) {
    console.log(`Subset: ${describeSubset(args)} → ${startUrls.length} Seiten (nur diese, kein Folgen).`);
  } else if (args.sitemap && startUrls.length > args.max) {
    console.warn(
      `⚠ Sitemap listet ${startUrls.length} URLs, aber max=${args.max} → nur ${args.max} werden gecrawlt. Erhöhe --max, oder nutze --newest/--oldest/--from/--to.`,
    );
  }

  if (langSet) console.log(`Sprachfilter aktiv: nur ${[...langSet].join(", ")} (+ sprachneutrale URLs).`);

  console.log(
    `Crawling ${startUrls.length} seed URL(s), base=${baseUrl}, ` +
      `concurrency=${args.concurrency}, max=${maxPages}, follow=${followLinks}, db=${!args.noDb}`,
  );

  let sink: Awaited<ReturnType<typeof makeSink>> | null = null;
  if (!args.noDb) {
    sink = await makeSink(baseUrl, args.sitemap);
  }

  const hooks: CrawlHooks = {
    onPage: async (page) => {
      if (!page.ok) {
        console.log(`  ✗ page ${page.status || "ERR"}  ${page.url}`);
      }
      await sink?.page(page);
    },
    onResult: async (page, result) => {
      for (const f of result.findings) {
        if (f.severity === "error") console.log(`  ↳ ${f.message}  (on ${f.url})`);
      }
      await sink?.result(page, result);
    },
  };

  const stats = await runCrawl({
    startUrls,
    baseUrl,
    analyzers: defaultAnalyzers(),
    concurrency: args.concurrency,
    maxPages,
    followLinks,
    allowedLangs: args.langs,
    politeness: {
      perHostConcurrency: args.perHost,
      minHostDelayMs: args.delay,
      respectRobots: !args.noRobots,
    },
    hooks,
  });

  // Post-crawl: verify claimed-broken links (drop transients) and audit the
  // sitemap, then finalize with an authoritative recount from the DB.
  if (sink) {
    const { verifyRunBrokenLinks, auditSitemap, finalizeRun } = await import("@linkchecker/db");
    const { rechecked, cleared } = await verifyRunBrokenLinks(sink.runId);
    if (cleared > 0) {
      console.log(`Verify-Pass: ${cleared} von ${rechecked} kaputten Links waren transient — entfernt.`);
    }
    if (args.sitemap) {
      const audit = await auditSitemap(sink.runId, startUrls, { cap: maxPages, baseUrl });
      if (audit.dead > 0) console.log(`Sitemap-Audit: ${audit.dead} gelistete URL(s) liefern 4xx.`);
    }
    await finalizeRun(sink.runId);
  }

  console.log(
    `\nDone. ${stats.pages} pages crawled, ${stats.findings} findings (vor Verify/Audit)` +
      `${stats.skipped > 0 ? `, ${stats.skipped} skipped (robots.txt)` : ""}.`,
  );
  if (sink) console.log(`Run id: ${sink.runId}`);
  process.exit(0);
}

async function makeSink(baseUrl: string, sitemapUrl?: string) {
  // Imported lazily so --no-db never touches DATABASE_URL.
  const { createRun, createSink } = await import("@linkchecker/db");
  const runId = await createRun({ baseUrl, sitemapUrl });
  return { runId, ...createSink(runId) };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

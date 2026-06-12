import "dotenv/config";
import { fetchSitemapUrls, runCrawl, type CrawlHooks } from "@linkchecker/core";
import { defaultAnalyzers } from "@linkchecker/analyzers";
import { parseArgs } from "./args.js";

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

  const startUrls = args.sitemap
    ? await fetchSitemapUrls(args.sitemap)
    : [args.url!];
  const baseUrl = args.base ?? startUrls[0]!;

  console.log(
    `Crawling ${startUrls.length} seed URL(s), base=${baseUrl}, ` +
      `concurrency=${args.concurrency}, max=${args.max}, db=${!args.noDb}`,
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
    maxPages: args.max,
    politeness: {
      perHostConcurrency: args.perHost,
      minHostDelayMs: args.delay,
      respectRobots: !args.noRobots,
    },
    hooks,
  });

  await sink?.finish(stats);
  console.log(
    `\nDone. ${stats.pages} pages crawled, ${stats.findings} findings` +
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

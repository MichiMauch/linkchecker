import "dotenv/config";
import { fetchSitemapUrls, normalizeUrl } from "@linkchecker/core";
import { createRun } from "@linkchecker/db";
import { connection, crawlQueue, enqueueSeed } from "@linkchecker/queue";
import { parseArgs } from "./args.js";

/**
 * Create a run and seed the distributed queue (run the worker separately).
 *
 *   npm run seed -- --sitemap https://example.com/sitemap.xml
 *   npm run seed -- --url https://example.com --max 5000
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawUrls = args.sitemap ? await fetchSitemapUrls(args.sitemap) : [args.url!];
  const baseUrl = args.base ?? rawUrls[0]!;
  const seedUrls = rawUrls
    .map((u) => normalizeUrl(u, baseUrl))
    .filter((u): u is string => !!u);

  const runId = await createRun({ baseUrl, sitemapUrl: args.sitemap });
  const n = await enqueueSeed(runId, seedUrls, baseUrl, args.max);

  console.log(`Seeded run ${runId} with ${n} URL(s). Start a worker to process them.`);
  await crawlQueue().close();
  connection().disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

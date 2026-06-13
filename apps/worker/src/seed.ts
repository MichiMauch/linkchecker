import "dotenv/config";
import { fetchSitemapUrls, langAllowed, normalizeUrl } from "@linkchecker/core";
import { createRun } from "@linkchecker/db";
import { connection, crawlQueue, enqueueSeed } from "@linkchecker/queue";
import { describeSubset, isSubsetCrawl, parseArgs } from "./args.js";

/**
 * Create a run and seed the distributed queue (run the worker separately).
 *
 *   npm run seed -- --sitemap https://example.com/sitemap.xml
 *   npm run seed -- --url https://example.com --max 5000
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sitemapOpts = {
    ...(args.dateRange ? { filter: args.dateRange } : {}),
    ...(args.select ? { select: args.select } : {}),
  };
  const rawUrls = args.sitemap ? await fetchSitemapUrls(args.sitemap, sitemapOpts) : [args.url!];
  const baseUrl = args.base ?? rawUrls[0]!;
  const langSet = args.langs && args.langs.length > 0 ? new Set(args.langs) : null;
  const seedUrls = rawUrls
    .map((u) => normalizeUrl(u, baseUrl))
    .filter((u): u is string => !!u && langAllowed(u, langSet));

  // A sitemap subset = crawl exactly those pages, no link-following.
  const subset = isSubsetCrawl(args);
  const follow = !subset;
  const max = subset ? seedUrls.length : args.max;

  const runId = await createRun({ baseUrl, sitemapUrl: args.sitemap });
  const { enqueued, total } = await enqueueSeed(runId, seedUrls, baseUrl, max, {
    sitemapUrls: args.sitemap ? seedUrls : undefined,
    follow,
    langs: args.langs,
  });
  if (langSet) {
    console.log(`Sprachfilter aktiv: nur ${[...langSet].join(", ")} (+ sprachneutrale URLs).`);
  }

  if (subset) {
    console.log(`Subset: ${describeSubset(args)} → ${enqueued} Seiten (nur diese, kein Folgen).`);
  } else if (args.sitemap && total > enqueued) {
    console.warn(
      `⚠ Sitemap listet ${total} URLs, aber max=${args.max} → nur ${enqueued} werden gecrawlt. Erhöhe --max, oder nutze --newest/--oldest/--from/--to.`,
    );
  }
  console.log(`Seeded run ${runId} with ${enqueued} URL(s). Start a worker to process them.`);
  await crawlQueue().close();
  connection().disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

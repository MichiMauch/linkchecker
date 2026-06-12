import "dotenv/config";
import { fetchSitemapUrls, normalizeUrl } from "@linkchecker/core";
import { createRun } from "@linkchecker/db";
import { connection, crawlQueue, seenKey } from "./queue.js";
import { parseArgs } from "./args.js";

/**
 * Create a run and seed the distributed queue (run the worker separately).
 *
 *   npm run seed -- --sitemap https://example.com/sitemap.xml
 *   npm run seed -- --url https://example.com
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startUrls = args.sitemap ? await fetchSitemapUrls(args.sitemap) : [args.url!];
  const baseUrl = args.base ?? startUrls[0]!;

  const runId = await createRun({ baseUrl, sitemapUrl: args.sitemap });

  let enqueued = 0;
  for (const u of startUrls) {
    const n = normalizeUrl(u, baseUrl);
    if (!n) continue;
    const isNew = await connection.sadd(seenKey(runId), n);
    if (isNew === 1) {
      await crawlQueue.add(
        "crawl",
        { runId, url: n, baseUrl },
        { removeOnComplete: true, removeOnFail: 1000 },
      );
      enqueued++;
    }
  }

  console.log(`Seeded run ${runId} with ${enqueued} URL(s). Start a worker to process them.`);
  await crawlQueue.close();
  await connection.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

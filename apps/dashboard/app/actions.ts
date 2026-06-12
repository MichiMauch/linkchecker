"use server";

import { redirect } from "next/navigation";
import { fetchSitemapUrls, normalizeUrl, runCrawl } from "@linkchecker/core";
import { defaultAnalyzers } from "@linkchecker/analyzers";
import { createRun, createSink } from "@linkchecker/db";
import { enqueueSeed, pingRedis } from "@linkchecker/queue";

/**
 * Server action: kick off a crawl from the dashboard. Creates the run and
 * either:
 *  - WORKER MODE (USE_WORKER=true + Redis reachable): enqueues the seed URLs
 *    and lets the separate worker process(es) do the crawling. Survives a web
 *    server restart and scales horizontally.
 *  - IN-PROCESS (default): crawls inside this Node server process. Zero infra,
 *    great for local/self-hosted; a restart mid-crawl aborts it.
 *
 * Either way the request returns immediately and the run page polls for
 * progress.
 */
export async function startCrawl(formData: FormData): Promise<void> {
  const raw = String(formData.get("target") ?? "").trim();
  const target = normalizeInputUrl(raw);
  if (!target) return;

  const base = new URL(target).origin;
  const max = Number(formData.get("max")) || 500;
  const isSitemap = target.toLowerCase().endsWith(".xml");

  const runId = await createRun({
    baseUrl: base,
    sitemapUrl: isSitemap ? target : undefined,
  });

  const useWorker =
    (process.env.USE_WORKER === "true" || process.env.USE_WORKER === "1") &&
    (await pingRedis());

  if (useWorker) {
    const seedUrls = (isSitemap ? await fetchSitemapUrls(target) : [target])
      .map((u) => normalizeUrl(u, base))
      .filter((u): u is string => !!u);
    await enqueueSeed(runId, seedUrls, base, max);
  } else {
    // Fire-and-forget: do NOT await — let the request return and the page poll.
    void runInBackground({ runId, target, isSitemap, base, max });
  }

  redirect(`/runs/${runId}`);
}

/**
 * Accept input WITHOUT a scheme — the user never wants to type `https://`.
 * `example.com`, `www.example.com`, `example.com/sitemap.xml` all work; a
 * scheme is prepended only when missing. Returns null if it's not a valid URL.
 */
function normalizeInputUrl(raw: string): string | null {
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

interface BackgroundOpts {
  runId: string;
  target: string;
  isSitemap: boolean;
  base: string;
  max: number;
}

async function runInBackground({ runId, target, isSitemap, base, max }: BackgroundOpts): Promise<void> {
  const sink = createSink(runId);
  try {
    const startUrls = isSitemap ? await fetchSitemapUrls(target) : [target];
    let pages = 0;
    let findings = 0;

    const stats = await runCrawl({
      startUrls,
      baseUrl: base,
      analyzers: defaultAnalyzers(),
      concurrency: 10,
      maxPages: max,
      hooks: {
        onPage: async (page) => {
          await sink.page(page);
          pages++;
          if (pages % 20 === 0) await sink.progress(pages, findings);
        },
        onResult: async (page, result) => {
          await sink.result(page, result);
          findings += result.findings.length;
        },
      },
    });

    await sink.finish(stats);
  } catch (err) {
    console.error(`Crawl ${runId} failed:`, err);
    await sink.fail();
  }
}

"use server";

import { redirect } from "next/navigation";
import { fetchSitemapUrls, runCrawl } from "@linkchecker/core";
import { LinkChecker } from "@linkchecker/analyzers";
import { createRun, createSink } from "@linkchecker/db";

/**
 * Server action: kick off a crawl from the dashboard. Creates the run, starts
 * the crawl in the background (so the request returns immediately), and
 * redirects to the run page where progress updates live.
 *
 * NOTE: the crawl runs inside this Node server process. Fine for a
 * self-hosted, long-running server (Coolify/Hetzner). For very large sites or
 * serverless deployments, route the work to the BullMQ worker instead.
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

  // Fire-and-forget: do NOT await — let the request return and the page poll.
  void runInBackground({ runId, target, isSitemap, base, max });

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
      analyzers: [new LinkChecker()],
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

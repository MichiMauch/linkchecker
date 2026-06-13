"use server";

import { redirect } from "next/navigation";
import { langAllowed, normalizeUrl, parseLangs, resolveSiteSitemap, runCrawl } from "@linkchecker/core";
import { defaultAnalyzers } from "@linkchecker/analyzers";
import {
  auditSitemap,
  createRun,
  createSink,
  finalizeRun,
  verifyRunBrokenLinks,
} from "@linkchecker/db";
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

  // Subset by <lastmod>: newest/oldest N and/or a date window. These work for a
  // bare domain too — the sitemap is resolved automatically (see resolveSeeds).
  const subset = String(formData.get("subset") ?? "none");
  const subsetN = Number(formData.get("subsetN")) || 0;
  let select: { order: "newest" | "oldest"; limit: number } | undefined;
  if (subsetN > 0 && (subset === "newest" || subset === "oldest")) {
    select = { order: subset, limit: subsetN };
  }
  const fromRaw = String(formData.get("from") ?? "").trim();
  const toRaw = String(formData.get("to") ?? "").trim();
  const from = fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? fromRaw : undefined;
  const to = toRaw && !Number.isNaN(Date.parse(toRaw)) ? toRaw : undefined;
  const dateRange = from || to ? { from, to } : undefined;

  // Language filter (e.g. "fr, it") — gates seeds and discovered links.
  const langs = parseLangs(String(formData.get("langs") ?? ""));

  const runId = await createRun({ baseUrl: base, sitemapUrl: target });

  const useWorker =
    (process.env.USE_WORKER === "true" || process.env.USE_WORKER === "1") &&
    (await pingRedis());

  if (useWorker) {
    // Worker mode needs the seeds before enqueuing, so resolve up front.
    const { seedUrls, isSitemapCrawl } = await resolveSeeds({ target, base, select, dateRange, langs });
    const isSubset = !!(select || dateRange);
    await enqueueSeed(runId, seedUrls, base, isSubset ? seedUrls.length : max, {
      sitemapUrls: isSitemapCrawl ? seedUrls : undefined,
      follow: !isSubset,
      langs,
    });
  } else {
    // Fire-and-forget: resolution + crawl happen in the background so the
    // request returns immediately and the run page polls for progress.
    void runInBackground({ runId, target, base, max, select, dateRange, langs });
  }

  redirect(`/runs/${runId}`);
}

interface ResolveArgs {
  target: string;
  base: string;
  select?: { order: "newest" | "oldest"; limit: number };
  dateRange?: { from?: string; to?: string };
  langs: string[];
}

/**
 * Turn a target into normalized seed URLs. A `.xml` is used directly; a bare
 * domain is auto-resolved to its sitemap(s) via robots.txt (or /sitemap.xml).
 * Falls back to a single-URL crawl when no sitemap is found.
 */
async function resolveSeeds({
  target,
  base,
  select,
  dateRange,
  langs,
}: ResolveArgs): Promise<{ seedUrls: string[]; isSitemapCrawl: boolean }> {
  const langSet = langs.length > 0 ? new Set(langs) : null;
  const resolved = await resolveSiteSitemap(target, {
    ...(dateRange ? { filter: dateRange } : {}),
    ...(select ? { select } : {}),
    langs,
  });
  const isSitemapCrawl = resolved.urls.length > 0;
  const seedUrls = (isSitemapCrawl ? resolved.urls : [target])
    .map((u) => normalizeUrl(u, base))
    .filter((u): u is string => !!u && langAllowed(u, langSet));
  return { seedUrls, isSitemapCrawl };
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
  base: string;
  max: number;
  select?: { order: "newest" | "oldest"; limit: number };
  dateRange?: { from?: string; to?: string };
  langs: string[];
}

async function runInBackground({
  runId,
  target,
  base,
  max,
  select,
  dateRange,
  langs,
}: BackgroundOpts): Promise<void> {
  const sink = createSink(runId);
  try {
    const { seedUrls: startUrls, isSitemapCrawl } = await resolveSeeds({
      target,
      base,
      select,
      dateRange,
      langs,
    });
    // A sitemap subset = check exactly those pages, no link-following.
    const isSubset = !!(select || dateRange);
    const followLinks = !isSubset;
    const maxPages = isSubset ? startUrls.length : max;
    let pages = 0;
    let findings = 0;

    await runCrawl({
      startUrls,
      baseUrl: base,
      analyzers: defaultAnalyzers(),
      concurrency: 10,
      maxPages,
      followLinks,
      allowedLangs: langs,
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

    // Post-crawl: drop transient false positives, audit the sitemap, then
    // finalize with an authoritative recount (matches the worker path).
    await verifyRunBrokenLinks(runId);
    if (isSitemapCrawl) await auditSitemap(runId, startUrls, { cap: maxPages, baseUrl: base });
    await finalizeRun(runId);
  } catch (err) {
    console.error(`Crawl ${runId} failed:`, err);
    await sink.fail();
  }
}

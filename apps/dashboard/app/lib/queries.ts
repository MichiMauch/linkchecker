import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { getAcceptedFixes, getDb, getFixes, schema } from "@linkchecker/db";
import { toFixView, type FixView } from "../fix-types.js";
import type { RedirectPair } from "./redirects.js";

const { runs, findings, links, pages } = schema;

export type Run = typeof runs.$inferSelect;
export type Finding = typeof findings.$inferSelect;

/** Most recent runs, newest first. */
export async function getRecentRuns(limit = 20): Promise<Run[]> {
  const db = await getDb();
  return db.select().from(runs).orderBy(desc(runs.startedAt)).limit(limit);
}

export async function getLatestRun(): Promise<Run | null> {
  const db = await getDb();
  const [row] = await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(1);
  return row ?? null;
}

export async function getRun(id: string): Promise<Run | null> {
  const db = await getDb();
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

/**
 * Genuinely broken on-page links (error severity). Excludes `dead-sitemap-url`
 * — those are listed-but-dead sitemap entries, shown in their own section.
 */
export async function getBrokenLinks(runId: string): Promise<Finding[]> {
  const db = await getDb();
  return db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.runId, runId),
        eq(findings.severity, "error"),
        ne(findings.type, "dead-sitemap-url"),
      ),
    )
    .orderBy(desc(findings.createdAt));
}

/** URLs the sitemap advertises that return a 4xx (dead listed entries). */
export async function getDeadSitemapUrls(runId: string): Promise<Finding[]> {
  const db = await getDb();
  return db
    .select()
    .from(findings)
    .where(and(eq(findings.runId, runId), eq(findings.type, "dead-sitemap-url")))
    .orderBy(desc(findings.createdAt));
}

/** The truncation notice if the sitemap was larger than the crawl cap, else null. */
export async function getSitemapTruncation(runId: string): Promise<Finding | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(findings)
    .where(and(eq(findings.runId, runId), eq(findings.type, "sitemap-truncated")))
    .limit(1);
  return row ?? null;
}

/** Accepted fixes as redirect path-pairs (for the export). */
export async function getRedirectPairs(runId: string): Promise<RedirectPair[]> {
  const fixes = await getAcceptedFixes(runId);
  return fixes
    .map((f) => ({ from: toPath(f.targetUrl), to: toPath(f.suggestedUrl) }))
    .filter((p) => p.from && p.to && p.from !== p.to);
}

function toPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Cached fix suggestions for a run, keyed by broken target URL. */
export async function getFixViews(runId: string): Promise<Record<string, FixView>> {
  const raw = await getFixes(runId);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, toFixView(v)]));
}

/** Soft-404 findings (pages served 200 but really "not found"). */
export async function getSoftErrors(runId: string): Promise<Finding[]> {
  const db = await getDb();
  return db
    .select()
    .from(findings)
    .where(and(eq(findings.runId, runId), eq(findings.type, "soft-404")))
    .orderBy(desc(findings.createdAt));
}

/** How many internal links point at each of the given target URLs. */
export async function getInboundLinkCounts(
  runId: string,
  urls: string[],
): Promise<Record<string, number>> {
  if (urls.length === 0) return {};
  const db = await getDb();
  const rows = await db
    .select({ target: links.targetUrl, c: count() })
    .from(links)
    .where(and(eq(links.runId, runId), inArray(links.targetUrl, urls)))
    .groupBy(links.targetUrl);
  return Object.fromEntries(rows.map((r) => [r.target, r.c]));
}

/**
 * Links we couldn't confirm as genuinely dead: bot-blocked (403/999),
 * unreachable (transient timeout/reset), server errors (5xx), and dead
 * `#fragment` anchors. None of these are counted as real 404s.
 */
export async function getUncheckableLinks(runId: string): Promise<Finding[]> {
  const db = await getDb();
  return db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.runId, runId),
        inArray(findings.type, [
          "blocked",
          "unreachable",
          "server-error",
          "broken-anchor",
          "broken-hreflang",
        ]),
      ),
    )
    .orderBy(desc(findings.createdAt));
}

/** Live count of pages already crawled for a run (for running runs). */
export async function getRunPageCount(runId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ c: count() }).from(pages).where(eq(pages.runId, runId));
  return row?.c ?? 0;
}

/** Count of broken vs total links for a run (quick summary). */
export async function getLinkSummary(runId: string): Promise<{ broken: number; total: number }> {
  const db = await getDb();
  const all = await db.select({ ok: links.ok }).from(links).where(eq(links.runId, runId));
  return {
    total: all.length,
    broken: all.filter((l) => l.ok === false).length,
  };
}

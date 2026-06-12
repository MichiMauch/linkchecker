import { and, count, eq } from "drizzle-orm";
import type { AnalyzerResult, FetchedPage } from "@linkchecker/core";
import { getDb } from "./client.js";
import {
  findings as findingsTable,
  linkFixes,
  links as linksTable,
  pages,
  runs,
} from "./schema.js";

export interface RunMeta {
  baseUrl: string;
  sitemapUrl?: string;
}

/** Insert a new run row and return its id. */
export async function createRun(meta: RunMeta): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(runs)
    .values({ baseUrl: meta.baseUrl, sitemapUrl: meta.sitemapUrl ?? null })
    .returning({ id: runs.id });
  return row!.id;
}

/**
 * A persistence sink wired to a run. Pass its methods as crawl hooks; the
 * same sink works for both the in-process crawler and the BullMQ worker.
 */
export function createSink(runId: string) {
  return {
    async page(p: FetchedPage): Promise<void> {
      const db = await getDb();
      await db.insert(pages).values({
        runId,
        url: p.url,
        finalUrl: p.finalUrl,
        title: p.title ?? null,
        status: p.status,
        ok: p.ok,
        contentType: p.contentType,
        redirectChain: p.redirectChain,
        error: p.error ?? null,
      });
    },

    async result(_page: FetchedPage, result: AnalyzerResult): Promise<void> {
      const db = await getDb();
      if (result.findings.length > 0) {
        await db.insert(findingsTable).values(
          result.findings.map((f) => ({
            runId,
            analyzer: f.analyzer,
            type: f.type,
            severity: f.severity,
            message: f.message,
            url: f.url,
            detail: f.detail ?? null,
          })),
        );
      }
      if (result.links && result.links.length > 0) {
        await db.insert(linksTable).values(
          result.links.map((l) => ({
            runId,
            sourceUrl: l.source,
            targetUrl: l.target,
            internal: l.internal,
            rel: l.rel ?? null,
            anchorText: l.anchorText ?? null,
            status: l.status ?? null,
            ok: l.ok ?? null,
            redirectChain: l.redirectChain ?? null,
            error: l.error ?? null,
          })),
        );
      }
    },

    /** Live progress update while a crawl is running. */
    async progress(pagesCrawled: number, findingsCount: number): Promise<void> {
      const db = await getDb();
      await db.update(runs).set({ pagesCrawled, findingsCount }).where(eq(runs.id, runId));
    },

    async finish(stats: { pages: number; findings: number }): Promise<void> {
      const db = await getDb();
      await db
        .update(runs)
        .set({
          status: "done",
          finishedAt: new Date(),
          pagesCrawled: stats.pages,
          findingsCount: stats.findings,
        })
        .where(eq(runs.id, runId));
    },

    async fail(): Promise<void> {
      const db = await getDb();
      await db
        .update(runs)
        .set({ status: "failed", finishedAt: new Date() })
        .where(eq(runs.id, runId));
    },
  };
}

export type RunSink = ReturnType<typeof createSink>;

/**
 * Mark a run complete by counting its rows. Used by the distributed worker,
 * which has no single in-memory stats object to call finish() with.
 */
export async function finalizeRun(runId: string): Promise<void> {
  const db = await getDb();
  const [p] = await db.select({ n: count() }).from(pages).where(eq(pages.runId, runId));
  const [f] = await db.select({ n: count() }).from(findingsTable).where(eq(findingsTable.runId, runId));
  await db
    .update(runs)
    .set({
      status: "done",
      finishedAt: new Date(),
      pagesCrawled: p?.n ?? 0,
      findingsCount: f?.n ?? 0,
    })
    .where(eq(runs.id, runId));
}

// --- Phase 2: fix suggestions for broken internal links -------------------

export interface PageCandidate {
  url: string;
  title: string | null;
}

export interface FixResultInput {
  suggestedUrl: string | null;
  confidence: number;
  reason: string;
  method: string;
}

export type LinkFix = typeof linkFixes.$inferSelect;

/** Live, real internal pages for a run (ok=true, excluding soft-404 pages). */
export async function getValidPages(runId: string): Promise<PageCandidate[]> {
  const db = await getDb();
  const soft = await db
    .select({ u: findingsTable.url })
    .from(findingsTable)
    .where(and(eq(findingsTable.runId, runId), eq(findingsTable.type, "soft-404")));
  const softSet = new Set(soft.map((s) => s.u));
  const rows = await db
    .select({ url: pages.url, title: pages.title })
    .from(pages)
    .where(and(eq(pages.runId, runId), eq(pages.ok, true)));
  return rows.filter((r) => !softSet.has(r.url)).map((r) => ({ url: r.url, title: r.title }));
}

/** Distinct anchor texts used to link to a target (the link's intent). */
export async function getAnchorTexts(runId: string, target: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ a: linksTable.anchorText })
    .from(linksTable)
    .where(and(eq(linksTable.runId, runId), eq(linksTable.targetUrl, target)));
  const set = new Set<string>();
  for (const r of rows) if (r.a) set.add(r.a);
  return [...set].slice(0, 10);
}

export async function getCachedFix(runId: string, target: string): Promise<LinkFix | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(linkFixes)
    .where(and(eq(linkFixes.runId, runId), eq(linkFixes.targetUrl, target)))
    .limit(1);
  return row ?? null;
}

export async function saveFix(runId: string, target: string, r: FixResultInput): Promise<LinkFix> {
  const db = await getDb();
  await db.delete(linkFixes).where(and(eq(linkFixes.runId, runId), eq(linkFixes.targetUrl, target)));
  const [row] = await db
    .insert(linkFixes)
    .values({
      runId,
      targetUrl: target,
      suggestedUrl: r.suggestedUrl,
      confidence: r.confidence,
      reason: r.reason,
      method: r.method,
      status: "suggested",
    })
    .returning();
  return row!;
}

export async function setFixStatus(
  runId: string,
  target: string,
  status: "accepted" | "rejected" | "suggested",
): Promise<LinkFix | null> {
  const db = await getDb();
  const [row] = await db
    .update(linkFixes)
    .set({ status })
    .where(and(eq(linkFixes.runId, runId), eq(linkFixes.targetUrl, target)))
    .returning();
  return row ?? null;
}

/** All cached fixes for a run, keyed by broken target URL. */
export async function getFixes(runId: string): Promise<Record<string, LinkFix>> {
  const db = await getDb();
  const rows = await db.select().from(linkFixes).where(eq(linkFixes.runId, runId));
  return Object.fromEntries(rows.map((r) => [r.targetUrl, r]));
}

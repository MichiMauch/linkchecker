import { and, count, eq, inArray } from "drizzle-orm";
import { checkStatus, type AnalyzerResult, type FetchOptions, type FetchedPage } from "@linkchecker/core";
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

// --- Verify pass: re-confirm claimed-broken links before reporting --------

/**
 * Finding types worth re-checking: anything that could be a transient false
 * positive. `blocked` (bot shields) is excluded — it won't change on a retry.
 */
const VERIFY_TYPES = ["broken-link", "dead-host", "server-error", "unreachable"] as const;

/**
 * After a crawl, re-check every link that was reported broken — once, fresh,
 * with retries — and drop the ones that now respond OK. This is the safety net
 * against flaky timeouts / transient 5xx that would otherwise be reported as
 * real 404s. Updates the affected `links` rows and recomputes `findingsCount`.
 *
 * Returns how many distinct targets were re-checked and how many findings were
 * cleared as transient.
 */
export async function verifyRunBrokenLinks(
  runId: string,
  opts: { fetch?: FetchOptions; concurrency?: number } = {},
): Promise<{ rechecked: number; cleared: number }> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(findingsTable)
    .where(
      and(
        eq(findingsTable.runId, runId),
        eq(findingsTable.analyzer, "link-checker"),
        inArray(findingsTable.type, [...VERIFY_TYPES]),
      ),
    );

  // Group findings by their target URL so each target is fetched only once.
  const byTarget = new Map<string, string[]>(); // target -> finding ids
  for (const f of rows) {
    const target = (f.detail as { target?: unknown } | null)?.target;
    if (typeof target !== "string") continue;
    const ids = byTarget.get(target) ?? [];
    ids.push(f.id);
    byTarget.set(target, ids);
  }

  const targets = [...byTarget.keys()];
  if (targets.length === 0) return { rechecked: 0, cleared: 0 };

  const fetchOpts: FetchOptions = { retries: 2, ...opts.fetch };
  let cleared = 0;
  let cursor = 0;
  const workers = Math.min(opts.concurrency ?? 5, targets.length);

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]!;
        const res = await checkStatus(target, fetchOpts);
        if (res.ok) {
          const ids = byTarget.get(target)!;
          await db.delete(findingsTable).where(inArray(findingsTable.id, ids));
          await db
            .update(linksTable)
            .set({ ok: true, status: res.status, error: null })
            .where(and(eq(linksTable.runId, runId), eq(linksTable.targetUrl, target)));
          cleared += ids.length;
        } else {
          // Still bad — keep the finding but sync the link row to the fresh status.
          await db
            .update(linksTable)
            .set({ ok: false, status: res.status })
            .where(and(eq(linksTable.runId, runId), eq(linksTable.targetUrl, target)));
        }
      }
    }),
  );

  if (cleared > 0) {
    const [f] = await db
      .select({ n: count() })
      .from(findingsTable)
      .where(eq(findingsTable.runId, runId));
    await db.update(runs).set({ findingsCount: f?.n ?? 0 }).where(eq(runs.id, runId));
  }

  return { rechecked: targets.length, cleared };
}

// --- Sitemap audit: dead listed URLs + truncation notice ------------------

/**
 * Cross-check the URLs a sitemap advertised against what the crawl actually
 * fetched, and record two sitemap-specific signals (analyzer `"sitemap"`):
 *
 *  - `dead-sitemap-url` (error): a URL listed in the sitemap that returned a
 *    4xx — you're advertising a dead page to search engines. High-confidence
 *    only (4xx); transient 5xx/timeouts are left out to avoid false positives.
 *  - `sitemap-truncated` (warning): the sitemap listed more URLs than the page
 *    cap allowed, so the crawl only covered part of it — raise `max` to finish.
 *
 * Idempotent: clears prior `"sitemap"` findings first. Does NOT recompute
 * `findingsCount`; callers finalize with {@link finalizeRun}, which recounts.
 */
export async function auditSitemap(
  runId: string,
  sitemapUrls: string[],
  opts: { cap: number; baseUrl: string },
): Promise<{ dead: number; truncated: boolean }> {
  const db = await getDb();
  await db
    .delete(findingsTable)
    .where(and(eq(findingsTable.runId, runId), eq(findingsTable.analyzer, "sitemap")));

  if (sitemapUrls.length === 0) return { dead: 0, truncated: false };

  const listed = new Set(sitemapUrls);
  const notOk = await db
    .select({ url: pages.url, status: pages.status, error: pages.error })
    .from(pages)
    .where(and(eq(pages.runId, runId), eq(pages.ok, false)));
  const dead = notOk.filter(
    (p) => listed.has(p.url) && typeof p.status === "number" && p.status >= 400 && p.status < 500,
  );

  const truncated = Number.isFinite(opts.cap) && sitemapUrls.length > opts.cap;

  const toInsert = [
    ...dead.map((p) => ({
      runId,
      analyzer: "sitemap",
      type: "dead-sitemap-url",
      severity: "error",
      message: `In Sitemap gelistet, aber HTTP ${p.status}: ${p.url}`,
      url: p.url,
      detail: { target: p.url, status: p.status, internal: true, error: p.error } as Record<
        string,
        unknown
      >,
    })),
    ...(truncated
      ? [
          {
            runId,
            analyzer: "sitemap",
            type: "sitemap-truncated",
            severity: "warning",
            message: `Sitemap enthält ${sitemapUrls.length} URLs, der Crawl deckte nur ${opts.cap} ab — erhöhe „max", um alle zu prüfen.`,
            url: opts.baseUrl,
            detail: { listed: sitemapUrls.length, cap: opts.cap } as Record<string, unknown>,
          },
        ]
      : []),
  ];

  if (toInsert.length > 0) await db.insert(findingsTable).values(toInsert);
  return { dead: dead.length, truncated };
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

/** Accepted fixes for a run (broken target → confirmed replacement). */
export async function getAcceptedFixes(
  runId: string,
): Promise<Array<{ targetUrl: string; suggestedUrl: string }>> {
  const db = await getDb();
  const rows = await db
    .select({ t: linkFixes.targetUrl, s: linkFixes.suggestedUrl })
    .from(linkFixes)
    .where(and(eq(linkFixes.runId, runId), eq(linkFixes.status, "accepted")));
  return rows
    .filter((r): r is { t: string; s: string } => !!r.s)
    .map((r) => ({ targetUrl: r.t, suggestedUrl: r.s }));
}

/** All cached fixes for a run, keyed by broken target URL. */
export async function getFixes(runId: string): Promise<Record<string, LinkFix>> {
  const db = await getDb();
  const rows = await db.select().from(linkFixes).where(eq(linkFixes.runId, runId));
  return Object.fromEntries(rows.map((r) => [r.targetUrl, r]));
}

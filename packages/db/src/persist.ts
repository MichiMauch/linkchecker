import { eq } from "drizzle-orm";
import type { AnalyzerResult, FetchedPage } from "@linkchecker/core";
import { getDb } from "./client.js";
import { findings as findingsTable, links as linksTable, pages, runs } from "./schema.js";

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

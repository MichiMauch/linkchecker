import { and, count, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@linkchecker/db";

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

/** Genuinely broken links (error severity) for a run. */
export async function getBrokenLinks(runId: string): Promise<Finding[]> {
  const db = await getDb();
  return db
    .select()
    .from(findings)
    .where(and(eq(findings.runId, runId), eq(findings.severity, "error")))
    .orderBy(desc(findings.createdAt));
}

/** Links we couldn't verify: bot-blocked (403/999) or unreachable (timeout). */
export async function getUncheckableLinks(runId: string): Promise<Finding[]> {
  const db = await getDb();
  return db
    .select()
    .from(findings)
    .where(
      and(eq(findings.runId, runId), inArray(findings.type, ["blocked", "unreachable"])),
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

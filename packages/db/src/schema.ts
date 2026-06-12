import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const uuid = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const now = () => new Date();

/** One crawl execution. Gives you history and trends over time. */
export const runs = sqliteTable("runs", {
  id: uuid(),
  baseUrl: text("base_url").notNull(),
  sitemapUrl: text("sitemap_url"),
  status: text("status").notNull().default("running"), // running | done | failed
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  pagesCrawled: integer("pages_crawled").notNull().default(0),
  findingsCount: integer("findings_count").notNull().default(0),
});

/** Every page fetched during a run, with its own HTTP outcome. */
export const pages = sqliteTable(
  "pages",
  {
    id: uuid(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    finalUrl: text("final_url"),
    title: text("title"),
    status: integer("status"),
    ok: integer("ok", { mode: "boolean" }),
    contentType: text("content_type"),
    redirectChain: text("redirect_chain", { mode: "json" }).$type<string[]>(),
    error: text("error"),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("pages_run_url_idx").on(t.runId, t.url)],
);

/** Outbound link edges: which page links to which target, and its status. */
export const links = sqliteTable(
  "links",
  {
    id: uuid(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    targetUrl: text("target_url").notNull(),
    internal: integer("internal", { mode: "boolean" }).notNull(),
    rel: text("rel"),
    anchorText: text("anchor_text"),
    status: integer("status"),
    ok: integer("ok", { mode: "boolean" }),
    redirectChain: text("redirect_chain", { mode: "json" }).$type<string[]>(),
    error: text("error"),
  },
  (t) => [index("links_run_idx").on(t.runId), index("links_broken_idx").on(t.runId, t.ok)],
);

/**
 * Generic findings table — every analyzer (link checker today, SEO/GEO/perf
 * tomorrow) writes here. The `detail` JSON column means new analyzers need no
 * schema migration.
 */
export const findings = sqliteTable(
  "findings",
  {
    id: uuid(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    analyzer: text("analyzer").notNull(),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    url: text("url").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("findings_run_idx").on(t.runId, t.analyzer)],
);

/**
 * Cached fix suggestions for broken internal links (Phase 2). One row per
 * (run, broken target). `status` tracks the user's accept/reject so Phase 3
 * (redirect/CMS export) can read the confirmed set.
 */
export const linkFixes = sqliteTable(
  "link_fixes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    targetUrl: text("target_url").notNull(),
    suggestedUrl: text("suggested_url"),
    confidence: real("confidence"),
    reason: text("reason"),
    method: text("method").notNull(), // lexical | llm | none
    status: text("status").notNull().default("suggested"), // suggested | accepted | rejected
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("link_fixes_run_idx").on(t.runId, t.targetUrl)],
);

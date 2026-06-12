/**
 * Idempotent schema bootstrap. Run on first DB access so a fresh local file
 * (or a fresh Turso database) just works — no migration step needed for the
 * happy path. For schema *changes* over time, generate proper migrations with
 * `npm run db:generate` and apply them; this DDL only creates what's missing.
 */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY NOT NULL,
  base_url text NOT NULL,
  sitemap_url text,
  status text NOT NULL DEFAULT 'running',
  started_at integer NOT NULL,
  finished_at integer,
  pages_crawled integer NOT NULL DEFAULT 0,
  findings_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pages (
  id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url text NOT NULL,
  final_url text,
  title text,
  status integer,
  ok integer,
  content_type text,
  redirect_chain text,
  error text,
  fetched_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_run_url_idx ON pages (run_id, url);

CREATE TABLE IF NOT EXISTS links (
  id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  target_url text NOT NULL,
  internal integer NOT NULL,
  rel text,
  anchor_text text,
  status integer,
  ok integer,
  redirect_chain text,
  error text
);
CREATE INDEX IF NOT EXISTS links_run_idx ON links (run_id);
CREATE INDEX IF NOT EXISTS links_broken_idx ON links (run_id, ok);

CREATE TABLE IF NOT EXISTS findings (
  id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  analyzer text NOT NULL,
  type text NOT NULL,
  severity text NOT NULL,
  message text NOT NULL,
  url text NOT NULL,
  detail text,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_run_idx ON findings (run_id, analyzer);

CREATE TABLE IF NOT EXISTS link_fixes (
  id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  target_url text NOT NULL,
  suggested_url text,
  confidence real,
  reason text,
  method text NOT NULL,
  status text NOT NULL DEFAULT 'suggested',
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS link_fixes_run_idx ON link_fixes (run_id, target_url);
`;

/**
 * Idempotent column additions for databases created before these columns
 * existed. Each runs separately and ignores "duplicate column" errors.
 */
export const MIGRATIONS = [
  "ALTER TABLE pages ADD COLUMN title text",
  "ALTER TABLE links ADD COLUMN anchor_text text",
];

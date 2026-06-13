import { gunzipSync } from "node:zlib";
import { request } from "undici";
import { XMLParser } from "fast-xml-parser";
import { DEFAULT_UA } from "./fetcher.js";
import { langAllowed } from "./lang.js";
import { loadRobots } from "./robots.js";

/** Pick a subset of sitemap entries by `<lastmod>` recency. */
export interface SitemapSelect {
  /** "newest" = most recently modified first; "oldest" = least recent first. */
  order: "newest" | "oldest";
  /** How many entries to keep after sorting. */
  limit: number;
}

/** Keep only entries whose `<lastmod>` falls within an inclusive date window. */
export interface SitemapDateRange {
  /** Inclusive lower bound (ISO date `2026-01-01` or full datetime). */
  from?: string;
  /** Inclusive upper bound. A date-only value includes the entire day. */
  to?: string;
}

export interface SitemapOptions {
  /** How deep to follow nested sitemaps. Default 5. */
  maxDepth?: number;
  userAgent?: string;
  /** Hard cap on returned page URLs (guards against runaway huge sitemaps). Default unlimited. */
  limit?: number;
  /** Keep only entries with `<lastmod>` in this window (applied before {@link select}). */
  filter?: SitemapDateRange;
  /** Keep only the newest/oldest N entries by `<lastmod>` (see {@link selectSitemapEntries}). */
  select?: SitemapSelect;
}

/**
 * Keep entries whose `<lastmod>` is within `[from, to]` (inclusive). Entries
 * without a parseable `<lastmod>` are dropped — a date window can't judge them.
 * A date-only `to` (e.g. `2026-03-01`) includes that whole day.
 */
export function filterSitemapEntriesByDate(
  entries: SitemapEntry[],
  range: SitemapDateRange,
): SitemapEntry[] {
  const fromTs = range.from ? Date.parse(range.from) : undefined;
  let toTs = range.to ? Date.parse(range.to) : undefined;
  if (toTs !== undefined && !Number.isNaN(toTs) && /^\d{4}-\d{2}-\d{2}$/.test(range.to!.trim())) {
    toTs += 86_400_000 - 1; // date-only upper bound → include the full day
  }
  return entries.filter((e) => {
    const t = e.lastmod ? Date.parse(e.lastmod) : NaN;
    if (Number.isNaN(t)) return false;
    if (fromTs !== undefined && !Number.isNaN(fromTs) && t < fromTs) return false;
    if (toTs !== undefined && !Number.isNaN(toTs) && t > toTs) return false;
    return true;
  });
}

/** One sitemap entry: the URL plus its declared last-modified timestamp, if any. */
export interface SitemapEntry {
  loc: string;
  /** Raw `<lastmod>` string (ISO-ish); undefined when the sitemap omits it. */
  lastmod?: string;
}

export interface SitemapResult {
  /** Flattened, de-duplicated page URLs — already selected/limited. */
  urls: string[];
  /** All de-duplicated entries (loc + lastmod) BEFORE selection, for transparency. */
  entries: SitemapEntry[];
  /** Sub-sitemaps that couldn't be fetched/parsed — surfaced, never silently dropped. */
  errors: Array<{ url: string; error: string }>;
  /** How many sitemap documents were fetched (index + leaves). */
  sitemapsFetched: number;
}

/**
 * Sort entries by `<lastmod>` and keep the newest/oldest N. Entries without a
 * parseable `<lastmod>` sort last in both directions, so a date-based pick
 * prefers entries that actually carry a timestamp.
 */
export function selectSitemapEntries(
  entries: SitemapEntry[],
  select: SitemapSelect,
): SitemapEntry[] {
  const ts = (e: SitemapEntry): number => (e.lastmod ? Date.parse(e.lastmod) : NaN);
  const sorted = [...entries].sort((a, b) => {
    const ta = ts(a);
    const tb = ts(b);
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na && nb) return 0;
    if (na) return 1; // undated entries always sort after dated ones
    if (nb) return -1;
    return select.order === "newest" ? tb - ta : ta - tb;
  });
  return sorted.slice(0, Math.max(0, select.limit));
}

/**
 * Fetch and flatten a sitemap into page URLs. Handles the three shapes big
 * sites use in the wild:
 *
 *  1. `<sitemapindex>` → a proper index of child sitemaps (recurse).
 *  2. `<urlset>` of pages → the normal leaf case.
 *  3. `<urlset>` whose `<loc>`s are themselves `.xml` sitemaps — a non-standard
 *     "index disguised as a urlset" (e.g. economiesuisse.ch). We detect the
 *     `.xml`/`.xml.gz` entries and recurse into them instead of mistaking them
 *     for pages. Without this, the crawler would fetch the XML files as
 *     "pages", find no HTML, and miss the entire site.
 *
 * Also: follows redirects, transparently gunzips `.xml.gz`, presents a real
 * browser UA (some WAFs block unknown bots on the sitemap too), and is
 * resilient — one broken sub-sitemap is recorded in `errors` and skipped rather
 * than aborting the whole flatten.
 */
export async function fetchSitemap(
  sitemapUrl: string,
  opts: SitemapOptions = {},
): Promise<SitemapResult> {
  const maxDepth = opts.maxDepth ?? 5;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const parser = new XMLParser({ ignoreAttributes: true });
  // With a date filter or selection we must collect ALL entries before
  // filtering/sorting, so the per-walk safety cap only applies otherwise.
  const collectCap = opts.select || opts.filter ? Number.POSITIVE_INFINITY : limit;

  const seen = new Set<string>(); // sitemap docs already walked (loop guard)
  const out = new Map<string, string | undefined>(); // loc -> lastmod (de-duped)
  const errors: Array<{ url: string; error: string }> = [];
  let sitemapsFetched = 0;

  await walk(sitemapUrl, 0);

  const entries: SitemapEntry[] = [...out].map(([loc, lastmod]) => ({ loc, lastmod }));
  let chosen = entries;
  if (opts.filter && (opts.filter.from || opts.filter.to)) {
    chosen = filterSitemapEntriesByDate(chosen, opts.filter);
  }
  if (opts.select) chosen = selectSitemapEntries(chosen, opts.select);
  return {
    urls: chosen.map((e) => e.loc).slice(0, limit),
    entries,
    errors,
    sitemapsFetched,
  };

  async function walk(url: string, depth: number): Promise<void> {
    if (depth > maxDepth || seen.has(url) || out.size >= collectCap) return;
    seen.add(url);

    let doc: SitemapDoc;
    try {
      doc = parser.parse(await fetchXml(url, userAgent)) as SitemapDoc;
      sitemapsFetched++;
    } catch (err) {
      errors.push({ url, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (doc.sitemapindex?.sitemap) {
      for (const entry of toArray(doc.sitemapindex.sitemap)) {
        const loc = locOf(entry);
        if (loc) await walk(loc, depth + 1);
      }
      return;
    }

    if (doc.urlset?.url) {
      for (const entry of toArray(doc.urlset.url)) {
        if (out.size >= collectCap) break;
        const loc = locOf(entry);
        if (!loc) continue;
        // A urlset entry that points at another sitemap → recurse, don't crawl it.
        if (looksLikeSitemap(loc)) await walk(loc, depth + 1);
        else if (!out.has(loc)) out.set(loc, lastmodOf(entry));
      }
    }
  }
}

/**
 * Back-compat convenience: just the flattened page URLs. Failed sub-sitemaps
 * are logged as warnings (use {@link fetchSitemap} for structured errors).
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  opts: SitemapOptions = {},
): Promise<string[]> {
  const { urls, errors } = await fetchSitemap(sitemapUrl, opts);
  for (const e of errors) {
    console.warn(`[sitemap] skipped ${e.url}: ${e.error}`);
  }
  return urls;
}

export interface ResolveSitemapOptions extends SitemapOptions {
  /** Only fetch language-matching sitemaps (by source URL path /xx/). Empty = all. */
  langs?: string[];
}

export interface ResolvedSitemap extends SitemapResult {
  /** The sitemap document URLs that were actually used (from robots.txt or fallback). */
  sources: string[];
}

/**
 * Resolve a target into page URLs, accepting either a sitemap URL OR a bare
 * site/domain:
 *  - target ends in `.xml` → use it directly.
 *  - otherwise → read robots.txt for `Sitemap:` entries (covers per-language
 *    sitemaps); fall back to `<origin>/sitemap.xml`.
 *
 * All discovered sitemaps are flattened and merged, then `filter` (date window)
 * and `select` (newest/oldest) are applied across the merged set. When `langs`
 * is set, only language-matching source sitemaps are fetched (so "domain + fr"
 * pulls just `/fr/sitemap.xml`). Returns `urls: []` when nothing is found — the
 * caller can then fall back to a plain URL crawl.
 */
export async function resolveSiteSitemap(
  target: string,
  opts: ResolveSitemapOptions = {},
): Promise<ResolvedSitemap> {
  const sources = await sitemapSourcesFor(target, opts);
  const merged = new Map<string, string | undefined>();
  const errors: Array<{ url: string; error: string }> = [];
  let sitemapsFetched = 0;

  for (const src of sources) {
    const r = await fetchSitemap(src, { maxDepth: opts.maxDepth, userAgent: opts.userAgent });
    sitemapsFetched += r.sitemapsFetched;
    errors.push(...r.errors);
    for (const e of r.entries) if (!merged.has(e.loc)) merged.set(e.loc, e.lastmod);
  }

  let entries: SitemapEntry[] = [...merged].map(([loc, lastmod]) => ({ loc, lastmod }));
  if (opts.filter && (opts.filter.from || opts.filter.to)) {
    entries = filterSitemapEntriesByDate(entries, opts.filter);
  }
  if (opts.select) entries = selectSitemapEntries(entries, opts.select);
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  return { urls: entries.map((e) => e.loc).slice(0, limit), entries, errors, sitemapsFetched, sources };
}

/** Determine which sitemap document(s) to read for a target (URL or domain). */
async function sitemapSourcesFor(target: string, opts: ResolveSitemapOptions): Promise<string[]> {
  if (/\.xml(\.gz)?(\?|#|$)/i.test(target)) return [target];
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    return [];
  }
  const robots = await loadRobots(origin, { userAgent: opts.userAgent });
  let sources =
    robots.sitemaps.length > 0
      ? robots.sitemaps
      : [new URL("/sitemap.xml", origin).toString()];
  const langs = opts.langs && opts.langs.length > 0 ? new Set(opts.langs) : null;
  if (langs) sources = sources.filter((s) => langAllowed(s, langs));
  return sources;
}

/** Fetch a sitemap document, following redirects and gunzipping when needed. */
async function fetchXml(url: string, userAgent: string): Promise<string> {
  const res = await request(url, {
    headers: { "user-agent": userAgent, accept: "application/xml,text/xml,*/*;q=0.8" },
    maxRedirections: 5,
  });
  if (res.statusCode >= 400) {
    await res.body.dump();
    throw new Error(`HTTP ${res.statusCode}`);
  }
  const buf = Buffer.from(await res.body.arrayBuffer());
  const gzippedByExt = /\.gz($|\?)/i.test(url);
  const gzippedByMagic = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return (gzippedByExt || gzippedByMagic ? gunzipSync(buf) : buf).toString("utf8");
}

/** True if a `<loc>` points at another sitemap file rather than a content page. */
function looksLikeSitemap(loc: string): boolean {
  try {
    return /\.xml(\.gz)?$/i.test(new URL(loc).pathname);
  } catch {
    return /\.xml(\.gz)?(\?|$)/i.test(loc);
  }
}

function locOf(entry: LocEntry): string | null {
  if (!entry?.loc) return null;
  const s = String(entry.loc).trim();
  return s || null;
}

function lastmodOf(entry: LocEntry): string | undefined {
  if (entry?.lastmod == null) return undefined;
  const s = String(entry.lastmod).trim();
  return s || undefined;
}

interface LocEntry {
  loc?: string;
  lastmod?: string;
}
interface SitemapDoc {
  sitemapindex?: { sitemap?: LocEntry | LocEntry[] };
  urlset?: { url?: LocEntry | LocEntry[] };
}

function toArray<T>(x: T | T[]): T[] {
  return Array.isArray(x) ? x : [x];
}

/**
 * Core contracts shared across the crawler and every analyzer.
 *
 * The central idea: a page is fetched ONCE, then handed to a list of
 * {@link Analyzer}s. The link checker is just the first analyzer — add more
 * (SEO, GEO, performance, a11y) by implementing the same interface.
 */

export type Severity = "info" | "warning" | "error";

/** A page after it has been fetched (redirects already followed). */
export interface FetchedPage {
  /** The URL we asked for. */
  url: string;
  /** The URL we ended up at after following redirects. */
  finalUrl: string;
  /** Final HTTP status (0 = network/transport error, see {@link error}). */
  status: number;
  /** True for 2xx/3xx — i.e. the page was reachable. */
  ok: boolean;
  contentType: string | null;
  /** Response body — only populated for HTML/text, empty otherwise. */
  body: string;
  /** <title> of the page, if HTML. Used for fix-suggestion matching. */
  title?: string;
  /** Intermediate URLs encountered while following redirects. */
  redirectChain: string[];
  fetchedAt: Date;
  /** Set when the request failed at the transport level. */
  error?: string;
}

/** A single thing an analyzer wants to report about a page. */
export interface Finding {
  /** Which analyzer produced this (e.g. "link-checker"). */
  analyzer: string;
  /** Machine-readable category, e.g. "broken-link", "redirect". */
  type: string;
  severity: Severity;
  /** Human-readable one-liner. */
  message: string;
  /** The page this finding is about. */
  url: string;
  /** Analyzer-specific payload — stored as JSONB, no schema migration needed. */
  detail?: Record<string, unknown>;
}

/** An outbound link discovered on a page, with its resolved status. */
export interface LinkEdge {
  source: string;
  target: string;
  internal: boolean;
  rel: string | null;
  /** Visible link text — the semantic intent, used for fix suggestions. */
  anchorText?: string | null;
  status?: number | null;
  ok?: boolean | null;
  redirectChain?: string[];
  error?: string;
}

/** What an analyzer returns after inspecting a page. */
export interface AnalyzerResult {
  findings: Finding[];
  /** Internal URLs the crawler should also visit (frontier expansion). */
  discoveredUrls: string[];
  /** Optional link edges to persist (the link checker fills these). */
  links?: LinkEdge[];
}

export interface StatusResult {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  redirectChain: string[];
  error?: string;
}

/** Shared services the crawler exposes to every analyzer. */
export interface CrawlContext {
  baseUrl: string;
  /** Whether a URL belongs to the site being crawled. */
  isInternal(url: string): boolean;
  /** Cached HEAD→GET status check — safe to call for the same URL many times. */
  checkStatus(url: string): Promise<StatusResult>;
  runId?: string;
}

/**
 * Implement this to add a new check. Keep it pure: read the page, return
 * findings + any internal URLs worth crawling. No I/O to the DB here — the
 * crawler's hooks handle persistence.
 */
export interface Analyzer {
  name: string;
  analyze(page: FetchedPage, ctx: CrawlContext): Promise<AnalyzerResult>;
}

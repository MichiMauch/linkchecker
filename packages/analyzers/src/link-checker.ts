import * as cheerio from "cheerio";
import {
  fragmentExists,
  isDeadHostError,
  normalizeUrl,
  type Analyzer,
  type AnalyzerResult,
  type CrawlContext,
  type FetchedPage,
  type Finding,
  type LinkEdge,
  type Severity,
} from "@linkchecker/core";

/** What kind of reference produced a target — anchors are crawlable, assets are not. */
type LinkKind = "link" | "asset";

interface SelectorSpec {
  selector: string;
  attr: string;
  /** Defaults to "link" (a crawlable navigation link) unless given. */
  kind?: LinkKind;
}

export interface LinkCheckerOptions {
  /**
   * Which elements/attributes to treat as references. Defaults to anchors plus
   * the common asset references (img/script/stylesheet/iframe/media) so a 404
   * on an image or script is caught too. Anything not `a[href]` is an "asset":
   * its status is checked but it never feeds the crawl frontier.
   */
  selectors?: SelectorSpec[];
  /** Emit a `warning` finding for links that resolve via a redirect. */
  reportRedirects?: boolean;
  /**
   * Validate `#fragment` links against the target page's actual anchors
   * (requires `ctx.getAnchors`). Internal targets only. Default true.
   */
  checkFragments?: boolean;
  /**
   * Validate `<link rel="alternate" hreflang>` language-alternate targets and
   * report ones that return a 4xx — a real SEO defect on multilingual sites.
   * The alternates are checked, never crawled. Default true.
   */
  checkHreflang?: boolean;
}

const DEFAULT_SELECTORS: SelectorSpec[] = [
  { selector: "a[href]", attr: "href", kind: "link" },
  { selector: "img[src]", attr: "src", kind: "asset" },
  { selector: "script[src]", attr: "src", kind: "asset" },
  { selector: "link[rel=stylesheet]", attr: "href", kind: "asset" },
  { selector: "iframe[src]", attr: "src", kind: "asset" },
  { selector: "source[src]", attr: "src", kind: "asset" },
  { selector: "video[src]", attr: "src", kind: "asset" },
  { selector: "audio[src]", attr: "src", kind: "asset" },
];

interface TargetMeta {
  rel: string | null;
  anchor: string;
  kind: LinkKind;
  /** Distinct `#fragment`s linked to this internal target (without the `#`). */
  fragments: Set<string>;
}

/**
 * The first analyzer: extracts links + assets from a page, checks each unique
 * target's status, records link edges, and reports broken/unreachable links
 * (plus redirects and dead `#fragment`s, optionally). Internal, reachable
 * anchor targets are returned as `discoveredUrls` so the crawler keeps walking.
 */
export class LinkChecker implements Analyzer {
  readonly name = "link-checker";
  private readonly selectors: SelectorSpec[];
  private readonly reportRedirects: boolean;
  private readonly checkFragments: boolean;
  private readonly checkHreflang: boolean;

  constructor(opts: LinkCheckerOptions = {}) {
    this.selectors = opts.selectors ?? DEFAULT_SELECTORS;
    this.reportRedirects = opts.reportRedirects ?? true;
    this.checkFragments = opts.checkFragments ?? true;
    this.checkHreflang = opts.checkHreflang ?? true;
  }

  async analyze(page: FetchedPage, ctx: CrawlContext): Promise<AnalyzerResult> {
    const $ = cheerio.load(page.body);

    // hashless target URL -> meta (first occurrence wins; dedup per page)
    const targets = new Map<string, TargetMeta>();
    for (const { selector, attr, kind = "link" } of this.selectors) {
      $(selector).each((_, el) => {
        const raw = $(el).attr(attr);
        if (!raw) return;
        const target = normalizeUrl(raw, page.finalUrl);
        if (!target) return; // skips mailto:, tel:, javascript:, bare #fragments
        if (isCloudflareInternal(target)) return; // /cdn-cgi/… — e.g. obfuscated emails
        let meta = targets.get(target);
        if (!meta) {
          meta = {
            rel: $(el).attr("rel") ?? null,
            anchor: ($(el).text() || "").replace(/\s+/g, " ").trim().slice(0, 200),
            kind,
            fragments: new Set(),
          };
          targets.set(target, meta);
        }
        // An anchor occurrence wins over an asset one for the same URL.
        if (kind === "link") meta.kind = "link";
        const frag = fragmentOf(raw, page.finalUrl);
        if (frag) meta.fragments.add(frag);
      });
    }

    const checked = await Promise.all(
      [...targets.entries()].map(async ([target, meta]) => {
        const internal = ctx.isInternal(target);
        const status = await ctx.checkStatus(target);
        return { target, meta, internal, status };
      }),
    );

    const links: LinkEdge[] = [];
    const findings: Finding[] = [];
    const discoveredUrls: string[] = [];
    const anchorChecks: Array<Promise<Finding | null>> = [];

    for (const { target, meta, internal, status } of checked) {
      const { rel, anchor, kind, fragments } = meta;
      links.push({
        source: page.url,
        target,
        internal,
        rel,
        anchorText: anchor || null,
        status: status.status,
        ok: status.ok,
        redirectChain: status.redirectChain,
        error: status.error,
      });

      if (!status.ok) {
        const klass = classify(status.status, status.error, status.errorCode);
        findings.push({
          analyzer: this.name,
          type: klass.type,
          severity: klass.severity,
          message: `${kind === "asset" ? "[Asset] " : ""}${klass.label(target, status.status, status.error)}`,
          url: page.url,
          detail: {
            target,
            status: status.status,
            internal,
            kind,
            error: status.error,
            errorCode: status.errorCode,
            redirectChain: status.redirectChain,
          },
        });
      } else if (this.reportRedirects && status.redirectChain.length > 0) {
        const hops = status.redirectChain.length;
        findings.push({
          analyzer: this.name,
          type: "redirect",
          severity: "warning",
          message: `Redirect (${hops} hop${hops > 1 ? "s" : ""}): ${target} → ${status.finalUrl}`,
          url: page.url,
          detail: {
            target,
            finalUrl: status.finalUrl,
            status: status.status,
            redirectChain: status.redirectChain,
          },
        });
      }

      if (kind === "link" && internal && status.ok) {
        discoveredUrls.push(status.finalUrl);
        // Validate each #fragment against the live target's anchors.
        if (this.checkFragments && fragments.size > 0 && ctx.getAnchors) {
          anchorChecks.push(
            this.checkAnchors(page.url, status.finalUrl, fragments, ctx),
          );
        }
      }
    }

    for (const f of await Promise.all(anchorChecks)) {
      if (f) findings.push(f);
    }

    if (this.checkHreflang) {
      findings.push(...(await this.checkHreflangAlternates($, page, ctx)));
    }

    return { findings, discoveredUrls, links };
  }

  /**
   * Check `<link rel="alternate" hreflang>` language alternates and flag ones
   * that return a 4xx — a broken language pointer search engines rely on.
   * Checked only (never crawled). 5xx/timeouts/bot-blocks are skipped to avoid
   * false positives; only a definitive client error counts.
   */
  private async checkHreflangAlternates(
    $: cheerio.CheerioAPI,
    page: FetchedPage,
    ctx: CrawlContext,
  ): Promise<Finding[]> {
    const alternates = new Map<string, string>(); // target -> hreflang value
    $("link[rel=alternate][hreflang]").each((_, el) => {
      const raw = $(el).attr("href");
      const hreflang = ($(el).attr("hreflang") ?? "").trim();
      if (!raw || !hreflang) return;
      const target = normalizeUrl(raw, page.finalUrl);
      if (target && !alternates.has(target)) alternates.set(target, hreflang);
    });
    if (alternates.size === 0) return [];

    const checks = await Promise.all(
      [...alternates.entries()].map(async ([target, hreflang]) => {
        const status = await ctx.checkStatus(target);
        return { target, hreflang, status };
      }),
    );

    const findings: Finding[] = [];
    for (const { target, hreflang, status } of checks) {
      if (status.status >= 400 && status.status < 500) {
        findings.push({
          analyzer: this.name,
          type: "broken-hreflang",
          severity: "warning",
          message: `Defekter hreflang-Verweis (${hreflang}, HTTP ${status.status}): ${target}`,
          url: page.url,
          detail: { target, hreflang, status: status.status, internal: ctx.isInternal(target) },
        });
      }
    }
    return findings;
  }

  /** Report `#fragment`s that don't resolve to any anchor on the target page. */
  private async checkAnchors(
    sourceUrl: string,
    target: string,
    fragments: Set<string>,
    ctx: CrawlContext,
  ): Promise<Finding | null> {
    const anchors = await ctx.getAnchors!(target);
    if (!anchors) return null; // target isn't HTML / unreadable → can't judge
    const missing = [...fragments].filter((f) => !fragmentExists(f, anchors));
    if (missing.length === 0) return null;
    return {
      analyzer: this.name,
      type: "broken-anchor",
      severity: "warning",
      message: `Sprungmarke fehlt: ${target}#${missing[0]}${missing.length > 1 ? ` (+${missing.length - 1})` : ""}`,
      url: sourceUrl,
      detail: { target, missingFragments: missing },
    };
  }
}

/**
 * Cloudflare-internal endpoints under `/cdn-cgi/` are never real site content.
 * Most importantly `/cdn-cgi/l/email-protection#<hex>` is Cloudflare's email
 * obfuscation: the served HTML carries it, but `email-decode.min.js` rewrites it
 * back to the real `mailto:` in the browser. Requesting the bare path 404s, so
 * without this guard every page with an obfuscated email reports a fake broken
 * link. Treat the whole prefix like a mailto: and skip it.
 */
function isCloudflareInternal(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith("/cdn-cgi/");
  } catch {
    return false;
  }
}

/** The `#fragment` of `raw` resolved against `base`, without the leading `#`, or null. */
function fragmentOf(raw: string, base: string): string | null {
  try {
    const hash = new URL(raw, base).hash;
    return hash ? hash.slice(1) : null;
  } catch {
    return null;
  }
}

interface Classification {
  type: string;
  severity: Severity;
  label(target: string, status: number, error?: string): string;
}

/**
 * Decide whether a non-OK link is genuinely broken or merely unverifiable.
 * The taxonomy is what makes the "real 404" count trustworthy:
 *
 * - dead host (ENOTFOUND/ECONNREFUSED/bad TLS) → "dead-host" — error (really gone)
 * - other transport error / status 0           → "unreachable" — warning (transient/flaky)
 * - 401/403/429/999                             → "blocked" — warning (auth wall / bot shield;
 *   999 is LinkedIn's anti-scraping response and does NOT mean dead)
 * - 5xx                                         → "server-error" — warning (server fault, not a
 *   missing page; survived retries but may still be temporary)
 * - 404/410 and other 4xx                       → "broken-link" — error (genuinely not found)
 */
function classify(status: number, error?: string, errorCode?: string): Classification {
  if (error || status === 0) {
    if (isDeadHostError(errorCode)) {
      return {
        type: "dead-host",
        severity: "error",
        label: (t, _s, e) => `Host nicht erreichbar (${errorCode}): ${t}${e ? ` (${e})` : ""}`,
      };
    }
    return {
      type: "unreachable",
      severity: "warning",
      label: (t, _s, e) => `Nicht erreichbar: ${t}${e ? ` (${e})` : ""}`,
    };
  }
  if (status === 401 || status === 403 || status === 429 || status === 999) {
    return {
      type: "blocked",
      severity: "warning",
      label: (t, s) => `Blockiert (HTTP ${s}, vermutlich Bot-Schutz): ${t}`,
    };
  }
  if (status >= 500) {
    return {
      type: "server-error",
      severity: "warning",
      label: (t, s) => `Serverfehler (HTTP ${s}, evtl. temporär): ${t}`,
    };
  }
  return {
    type: "broken-link",
    severity: "error",
    label: (t, s) => `HTTP ${s}: ${t}`,
  };
}

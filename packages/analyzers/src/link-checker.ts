import * as cheerio from "cheerio";
import {
  normalizeUrl,
  type Analyzer,
  type AnalyzerResult,
  type CrawlContext,
  type FetchedPage,
  type Finding,
  type LinkEdge,
  type Severity,
} from "@linkchecker/core";

export interface LinkCheckerOptions {
  /**
   * Which elements/attributes to treat as links. Defaults to anchors only;
   * add img/script/link to also validate assets.
   */
  selectors?: Array<{ selector: string; attr: string }>;
  /** Emit a `warning` finding for links that resolve via a redirect. */
  reportRedirects?: boolean;
}

const DEFAULT_SELECTORS = [{ selector: "a[href]", attr: "href" }];

/**
 * The first analyzer: extracts links from a page, checks each unique target's
 * status, records link edges, and reports broken/unreachable links (plus
 * redirects, optionally). Internal, reachable targets are returned as
 * `discoveredUrls` so the crawler keeps walking the site.
 */
export class LinkChecker implements Analyzer {
  readonly name = "link-checker";
  private readonly selectors: Array<{ selector: string; attr: string }>;
  private readonly reportRedirects: boolean;

  constructor(opts: LinkCheckerOptions = {}) {
    this.selectors = opts.selectors ?? DEFAULT_SELECTORS;
    this.reportRedirects = opts.reportRedirects ?? true;
  }

  async analyze(page: FetchedPage, ctx: CrawlContext): Promise<AnalyzerResult> {
    const $ = cheerio.load(page.body);

    // target URL -> rel attribute (first occurrence wins; dedup per page)
    const targets = new Map<string, string | null>();
    for (const { selector, attr } of this.selectors) {
      $(selector).each((_, el) => {
        const raw = $(el).attr(attr);
        if (!raw) return;
        const target = normalizeUrl(raw, page.finalUrl);
        if (!target) return; // skips mailto:, tel:, javascript:, #fragments
        if (!targets.has(target)) targets.set(target, $(el).attr("rel") ?? null);
      });
    }

    const checked = await Promise.all(
      [...targets.entries()].map(async ([target, rel]) => {
        const internal = ctx.isInternal(target);
        const status = await ctx.checkStatus(target);
        return { target, rel, internal, status };
      }),
    );

    const links: LinkEdge[] = [];
    const findings: Finding[] = [];
    const discoveredUrls: string[] = [];

    for (const { target, rel, internal, status } of checked) {
      links.push({
        source: page.url,
        target,
        internal,
        rel,
        status: status.status,
        ok: status.ok,
        redirectChain: status.redirectChain,
        error: status.error,
      });

      if (!status.ok) {
        const klass = classify(status.status, status.error);
        findings.push({
          analyzer: this.name,
          type: klass.type,
          severity: klass.severity,
          message: klass.label(target, status.status, status.error),
          url: page.url,
          detail: {
            target,
            status: status.status,
            internal,
            error: status.error,
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

      if (internal && status.ok) discoveredUrls.push(status.finalUrl);
    }

    return { findings, discoveredUrls, links };
  }
}

interface Classification {
  type: string;
  severity: Severity;
  label(target: string, status: number, error?: string): string;
}

/**
 * Decide whether a non-OK link is genuinely broken or merely unverifiable.
 *
 * - transport error / status 0 → "unreachable" (timeout, DNS, refused) — warning
 * - 401/403/429/999            → "blocked" (auth wall or bot protection) — warning
 *   999 in particular is LinkedIn's anti-scraping response; it does NOT mean
 *   the link is dead.
 * - everything else (404, 410, 400, 5xx, …) → genuinely "broken-link" — error
 */
function classify(status: number, error?: string): Classification {
  if (error || status === 0) {
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
  return {
    type: "broken-link",
    severity: "error",
    label: (t, s) => `HTTP ${s}: ${t}`,
  };
}

import { request } from "undici";
import { DEFAULT_UA } from "./fetcher.js";

export interface ProbeResult {
  /** Status returned for a URL that definitely does not exist. */
  status: number;
  /** HTML body (empty if non-HTML or on error). */
  html: string;
}

/**
 * Fetches a guaranteed-nonexistent URL per origin to learn how the site behaves
 * for missing pages:
 *  - 4xx  → the site handles 404s correctly (no soft-404 template).
 *  - 200  → the site serves a "not found" page with an OK status; the returned
 *           HTML is the template to match real pages against (soft-404).
 * Cached per origin so each site is probed once per crawl.
 */
export class SoftErrorProbe {
  private readonly cache = new Map<string, Promise<ProbeResult>>();

  constructor(private readonly opts: { userAgent?: string; timeoutMs?: number } = {}) {}

  get(origin: string): Promise<ProbeResult> {
    let pending = this.cache.get(origin);
    if (!pending) {
      pending = this.fetchProbe(origin);
      this.cache.set(origin, pending);
    }
    return pending;
  }

  private async fetchProbe(origin: string): Promise<ProbeResult> {
    const rand = Math.random().toString(36).slice(2);
    let url: string;
    try {
      url = new URL(`/__linkcheck_probe_${rand}__not_found`, origin).toString();
    } catch {
      return { status: 0, html: "" };
    }
    const timeout = this.opts.timeoutMs ?? 15_000;
    try {
      const res = await request(url, {
        maxRedirections: 5,
        headersTimeout: timeout,
        bodyTimeout: timeout,
        headers: {
          // Match the real fetch identity — a UA-sniffing server may serve a
          // different 404 template to bots, which would break the similarity match.
          "user-agent": this.opts.userAgent ?? DEFAULT_UA,
          accept: "text/html,application/xhtml+xml",
        },
      });
      const ct = res.headers["content-type"];
      const isHtml = typeof ct === "string" && /html/i.test(ct);
      const html = isHtml ? await res.body.text() : ((await res.body.dump()), "");
      return { status: res.statusCode, html };
    } catch {
      return { status: 0, html: "" };
    }
  }
}

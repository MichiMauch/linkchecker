import { fetchPage, isHtmlType, type FetchOptions } from "./fetcher.js";
import { hostOf, type Throttle } from "./throttle.js";
import { stripHash } from "./url.js";

/**
 * Validates `#fragment` links: fetches a target page once, extracts every
 * anchorable target (`id="…"` and `<a name="…">`), and caches the set for the
 * lifetime of one crawl. Lets the link checker flag links that point at a
 * section which no longer exists — a real broken link the status code can't see.
 *
 * Mirrors {@link StatusChecker}: per-crawl memoization, optional per-host
 * throttling, and a null result for anything that isn't readable HTML.
 */
export class AnchorChecker {
  private readonly cache = new Map<string, Promise<Set<string> | null>>();

  constructor(
    private readonly opts: FetchOptions = {},
    private readonly throttle?: Throttle,
  ) {}

  get(url: string): Promise<Set<string> | null> {
    const key = stripHash(url);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.throttle
        ? this.throttle.run(hostOf(key), () => this.fetchAnchors(key))
        : this.fetchAnchors(key);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async fetchAnchors(url: string): Promise<Set<string> | null> {
    const page = await fetchPage(url, this.opts);
    if (!page.ok || !isHtmlType(page.contentType) || !page.body) return null;
    return extractAnchors(page.body);
  }
}

const ANCHOR_RE = /\s(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s">]+))/gi;

/** All `id` and `name` attribute values in an HTML document, lowercased. */
export function extractAnchors(html: string): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const val = m[1] ?? m[2] ?? m[3];
    if (val) out.add(val.toLowerCase());
  }
  return out;
}

/** Fragments that are always valid (browser scrolls to top, no element needed). */
const ALWAYS_VALID = new Set(["", "top"]);

/** True if `fragment` resolves to an element in `anchors` (or is a special no-op fragment). */
export function fragmentExists(fragment: string, anchors: Set<string>): boolean {
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // keep the raw fragment if it isn't valid percent-encoding
  }
  const f = decoded.toLowerCase();
  return ALWAYS_VALID.has(f) || anchors.has(f);
}

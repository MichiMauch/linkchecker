/** URL helpers shared by the crawler and analyzers. */

/**
 * Resolve `raw` against `base`, drop the fragment, and return an absolute URL
 * string — or `null` if it isn't a usable http(s) URL (mailto:, tel:, etc.).
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * True if `url` lives on the same site as `base`, treating `www.` and the bare
 * domain as equivalent (so a crawl seeded at `kokomo.house` still follows links
 * to `www.kokomo.house` and vice versa — otherwise a www↔apex redirect stops
 * the crawl dead after the first page).
 */
export function isInternalUrl(url: string, base: URL): boolean {
  try {
    return canonicalHost(new URL(url, base).host) === canonicalHost(base.host);
  } catch {
    return false;
  }
}

function canonicalHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

/** Strip the fragment for use as a cache/dedup key. */
export function stripHash(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

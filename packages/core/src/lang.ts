/** Language helpers for multilingual sites (language lives in the URL path). */

// A path segment that looks like a language tag: "de", "fr", "en-US", "pt-br".
const LANG_SEGMENT_RE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

/**
 * Detect a page's language from the first path segment — the dominant pattern
 * for multilingual sites (`/de/…`, `/fr/…`, `/en-us/…`). Returns the lowercased
 * base code (`"en-US"` → `"en"`), or null when there's no language segment
 * (language-neutral pages: the root, assets, shared resources).
 */
export function detectLang(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const seg = pathname.split("/").find(Boolean);
  if (seg && LANG_SEGMENT_RE.test(seg)) return seg.slice(0, 2).toLowerCase();
  return null;
}

/**
 * Whether a URL passes a language allow-list. Language-neutral URLs (no
 * detectable language — root pages, assets) ALWAYS pass, so a crawl can still
 * start at the root and reach the chosen language. An empty/absent set means
 * "all languages allowed".
 */
export function langAllowed(url: string, allowed: ReadonlySet<string> | null): boolean {
  if (!allowed || allowed.size === 0) return true;
  const lang = detectLang(url);
  return lang === null || allowed.has(lang);
}

/** Parse a comma/space separated language list ("de, fr") into a lowercased set, or null. */
export function parseLangs(input: string | undefined): string[] {
  if (!input) return [];
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((s) => s.trim().slice(0, 2).toLowerCase())
        .filter((s) => /^[a-z]{2}$/.test(s)),
    ),
  ];
}

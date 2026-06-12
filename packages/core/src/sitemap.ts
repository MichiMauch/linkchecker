import { request } from "undici";
import { XMLParser } from "fast-xml-parser";

export interface SitemapOptions {
  /** How deep to follow nested <sitemapindex> entries. */
  maxDepth?: number;
  userAgent?: string;
}

/**
 * Fetch and flatten a sitemap (or sitemap index) into a list of page URLs.
 * Follows nested sitemap indexes recursively — Drupal's Simple XML Sitemap
 * splits large sites into chunks, so this handles that out of the box.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  opts: SitemapOptions = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 3;
  const userAgent = opts.userAgent ?? "LinkCheckerBot/0.1";
  const parser = new XMLParser({ ignoreAttributes: true });
  const seen = new Set<string>();
  const out: string[] = [];

  await walk(sitemapUrl, 0);
  return out;

  async function walk(url: string, depth: number): Promise<void> {
    if (depth > maxDepth || seen.has(url)) return;
    seen.add(url);

    const res = await request(url, {
      headers: { "user-agent": userAgent },
      maxRedirections: 5,
    });
    const xml = await res.body.text();
    const doc = parser.parse(xml) as SitemapDoc;

    if (doc.sitemapindex?.sitemap) {
      for (const entry of toArray(doc.sitemapindex.sitemap)) {
        if (entry.loc) await walk(String(entry.loc), depth + 1);
      }
    } else if (doc.urlset?.url) {
      for (const entry of toArray(doc.urlset.url)) {
        if (entry.loc) out.push(String(entry.loc));
      }
    }
  }
}

interface LocEntry {
  loc?: string;
}
interface SitemapDoc {
  sitemapindex?: { sitemap?: LocEntry | LocEntry[] };
  urlset?: { url?: LocEntry | LocEntry[] };
}

function toArray<T>(x: T | T[]): T[] {
  return Array.isArray(x) ? x : [x];
}

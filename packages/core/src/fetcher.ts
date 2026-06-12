import { request } from "undici";
import type { FetchedPage, StatusResult } from "./types.js";

export interface FetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
}

// A realistic browser UA dramatically reduces bogus 403/999 bot-blocks.
// (Some sites — notably LinkedIn — block automated requests regardless; those
// are reported as "blocked", not "broken".)
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface RawResult {
  status: number;
  finalUrl: string;
  redirectChain: string[];
  headers: Record<string, string | string[] | undefined>;
  body: Awaited<ReturnType<typeof request>>["body"];
}

/**
 * Low-level request that follows redirects MANUALLY so we can record the full
 * chain (undici's auto-follow hides it). Always returns the live body so the
 * caller is responsible for reading or dumping it.
 */
async function rawRequest(
  url: string,
  method: "GET" | "HEAD",
  opts: FetchOptions,
): Promise<RawResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 10;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const redirectChain: string[] = [];
  let current = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const res = await request(current, {
      method,
      maxRedirections: 0,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      headers: {
        "user-agent": userAgent,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "de-CH,de;q=0.9,en;q=0.8",
      },
    });
    const status = res.statusCode;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      redirectChain.push(current);
      await res.body.dump();
      const loc = Array.isArray(location) ? location[0]! : location;
      current = new URL(loc, current).toString();
      continue;
    }
    return { status, finalUrl: current, redirectChain, headers: res.headers, body: res.body };
  }
  throw new Error(`Too many redirects (>${maxRedirects}) starting at ${url}`);
}

/** GET a page; returns its body only when it's HTML/text. */
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const fetchedAt = new Date();
  try {
    const r = await rawRequest(url, "GET", opts);
    const contentType = headerStr(r.headers["content-type"]);
    let body = "";
    let title: string | undefined;
    if (isHtmlType(contentType)) {
      body = await r.body.text();
      title = extractTitle(body);
    } else {
      await r.body.dump();
    }
    return {
      url,
      finalUrl: r.finalUrl,
      status: r.status,
      ok: r.status >= 200 && r.status < 400,
      contentType,
      body,
      title,
      redirectChain: r.redirectChain,
      fetchedAt,
    };
  } catch (err) {
    return {
      url,
      finalUrl: url,
      status: 0,
      ok: false,
      contentType: null,
      body: "",
      redirectChain: [],
      fetchedAt,
      error: errMsg(err),
    };
  }
}

/**
 * Check a URL's reachability cheaply with HEAD, falling back to GET when the
 * server rejects HEAD (405/501/403) or errors out — many servers lie on HEAD.
 */
export async function checkStatus(url: string, opts: FetchOptions = {}): Promise<StatusResult> {
  try {
    let r = await rawRequest(url, "HEAD", opts);
    if (r.status === 403 || r.status === 405 || r.status === 501 || r.status >= 500) {
      await r.body.dump();
      r = await rawRequest(url, "GET", opts);
    }
    await r.body.dump();
    return {
      url,
      finalUrl: r.finalUrl,
      status: r.status,
      ok: r.status >= 200 && r.status < 400,
      redirectChain: r.redirectChain,
    };
  } catch (err) {
    return { url, finalUrl: url, status: 0, ok: false, redirectChain: [], error: errMsg(err) };
  }
}

export function isHtmlType(contentType: string | null): boolean {
  return !!contentType && /text\/html|application\/xhtml/i.test(contentType);
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const text = m[1]!
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return text || undefined;
}

function headerStr(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

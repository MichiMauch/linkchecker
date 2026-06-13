import { request } from "undici";
import { sleep } from "./throttle.js";
import type { FetchedPage, StatusResult } from "./types.js";

export interface FetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /**
   * Extra attempts on *transient* failures (timeouts, resets, 429, 5xx).
   * The first try is not counted, so `retries: 2` means up to 3 requests.
   * Real 4xx (404/410/403/…) are NEVER retried — a missing page is missing.
   * Default 2.
   */
  retries?: number;
  /** Base backoff in ms; grows exponentially per attempt, capped at 5s. Default 400. */
  retryBaseMs?: number;
}

// A realistic browser UA dramatically reduces bogus 403/999 bot-blocks.
// (Some sites — notably LinkedIn — block automated requests regardless; those
// are reported as "blocked", not "broken".)
// Exported so the soft-404 probe presents the SAME identity as real requests —
// otherwise a UA-sniffing server can serve a different template and break the
// similarity match.
export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * DNS/connection-level failures that mean the host genuinely isn't serving the
 * link — fail fast (no retry) and classify as a real `dead-host` error, not a
 * transient "unreachable" warning.
 */
const DEAD_HOST_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

/** True if an error code denotes a host that genuinely can't be reached (dead, not flaky). */
export function isDeadHostError(code: string | undefined): boolean {
  return !!code && DEAD_HOST_CODES.has(code);
}

/** Pull the underlying error code out of undici's nested cause chain. */
export function errorCodeOf(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code ?? undefined;
}

/** Retry transport errors unless they're a definitive dead-host signal. */
function isRetryableError(err: unknown): boolean {
  return !isDeadHostError(errorCodeOf(err));
}

/** 429 and 5xx are transient enough to be worth one more shot. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function backoff(baseMs: number, attempt: number): Promise<void> {
  await sleep(Math.min(baseMs * 2 ** attempt, 5_000));
}

/**
 * {@link rawRequest} wrapped in retry-with-backoff. Retries only on transient
 * conditions (network timeout/reset, 429, 5xx); returns a definitive 4xx
 * immediately. This is the single biggest lever against false "broken" reports.
 */
async function requestWithRetry(
  url: string,
  method: "GET" | "HEAD",
  opts: FetchOptions,
): Promise<RawResult> {
  const retries = Math.max(0, opts.retries ?? 2);
  const base = opts.retryBaseMs ?? 400;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await rawRequest(url, method, opts);
      if (attempt < retries && isRetryableStatus(r.status)) {
        await r.body.dump();
        await backoff(base, attempt);
        continue;
      }
      return r;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryableError(err)) {
        await backoff(base, attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

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
    const r = await requestWithRetry(url, "GET", opts);
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
      errorCode: errorCodeOf(err),
    };
  }
}

// Statuses where HEAD can't be trusted: the server either rejects the method
// outright (405/501) or — critically for 404 accuracy — returns a "not found"
// that a real GET would actually serve (many CDNs/edge configs mishandle HEAD).
// We always re-confirm these with a GET before believing them.
function needsGetConfirmation(status: number): boolean {
  return (
    status === 403 ||
    status === 404 ||
    status === 405 ||
    status === 410 ||
    status === 501 ||
    status >= 500
  );
}

/**
 * Check a URL's reachability cheaply with HEAD, falling back to GET when the
 * server rejects HEAD or reports a 404/410/5xx — many servers lie on HEAD, so
 * a "missing" verdict is always re-confirmed with a real GET before we trust it.
 */
export async function checkStatus(url: string, opts: FetchOptions = {}): Promise<StatusResult> {
  try {
    let r = await requestWithRetry(url, "HEAD", opts);
    if (needsGetConfirmation(r.status)) {
      await r.body.dump();
      r = await requestWithRetry(url, "GET", opts);
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
    return {
      url,
      finalUrl: url,
      status: 0,
      ok: false,
      redirectChain: [],
      error: errMsg(err),
      errorCode: errorCodeOf(err),
    };
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

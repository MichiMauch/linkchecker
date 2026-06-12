import { request } from "undici";
import robotsParserImport from "robots-parser";
import type { FetchOptions } from "./fetcher.js";

// robots-parser ships a malformed .d.ts (a shorthand ambient module), so the
// default import isn't typed as callable. Re-type it locally.
interface RobotsTxt {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
const robotsParser = robotsParserImport as unknown as (
  url: string,
  contents: string,
) => RobotsTxt;

export interface RobotsInfo {
  /** True unless robots.txt explicitly disallows this URL for our agent. */
  isAllowed(url: string): boolean;
  /** Crawl-delay in seconds, if specified. */
  crawlDelay: number | undefined;
  sitemaps: string[];
}

/** Used when there is no robots.txt (or it can't be fetched): allow everything. */
const PERMISSIVE: RobotsInfo = {
  isAllowed: () => true,
  crawlDelay: undefined,
  sitemaps: [],
};

export interface RobotsOptions {
  /** Token we present to robots.txt for group matching. */
  userAgent?: string;
  fetch?: FetchOptions;
}

/** Fetch and parse robots.txt for one origin. */
export async function loadRobots(origin: string, opts: RobotsOptions = {}): Promise<RobotsInfo> {
  const ua = opts.userAgent ?? "LinkChecker";
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", origin).toString();
  } catch {
    return PERMISSIVE;
  }

  try {
    const res = await request(robotsUrl, {
      maxRedirections: 3,
      headersTimeout: opts.fetch?.timeoutMs ?? 15_000,
      bodyTimeout: opts.fetch?.timeoutMs ?? 15_000,
      headers: { "user-agent": opts.fetch?.userAgent ?? ua },
    });
    if (res.statusCode >= 400) {
      await res.body.dump();
      return PERMISSIVE; // 404/403 → no rules → allow all
    }
    const body = await res.body.text();
    const robots = robotsParser(robotsUrl, body);
    return {
      // isAllowed returns undefined when no rule matches → treat as allowed.
      isAllowed: (url) => robots.isAllowed(url, ua) !== false,
      crawlDelay: robots.getCrawlDelay(ua),
      sitemaps: robots.getSitemaps(),
    };
  } catch {
    return PERMISSIVE;
  }
}

/**
 * Caches robots.txt per origin so a crawl fetches each site's rules once.
 * Correctly handles www↔apex (each origin gets its own lookup).
 */
export class RobotsGate {
  private readonly cache = new Map<string, Promise<RobotsInfo>>();

  constructor(private readonly opts: RobotsOptions = {}) {}

  get(url: string): Promise<RobotsInfo> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return Promise.resolve(PERMISSIVE);
    }
    let pending = this.cache.get(origin);
    if (!pending) {
      pending = loadRobots(origin, this.opts);
      this.cache.set(origin, pending);
    }
    return pending;
  }
}

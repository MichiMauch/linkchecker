import { checkStatus, type FetchOptions } from "./fetcher.js";
import { stripHash } from "./url.js";
import type { StatusResult } from "./types.js";

/**
 * Memoizes status checks for the lifetime of one crawl. Without this you'd
 * re-request popular external targets (twitter.com, fonts.googleapis.com, …)
 * hundreds of times and get rate-limited or banned.
 *
 * Scope it per crawl run (in-process) or per job (worker). For cross-worker
 * deduplication you'd back this with Redis — see README.
 */
export class StatusChecker {
  private readonly cache = new Map<string, Promise<StatusResult>>();

  constructor(private readonly opts: FetchOptions = {}) {}

  check(url: string): Promise<StatusResult> {
    const key = stripHash(url);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = checkStatus(key, this.opts);
      this.cache.set(key, pending);
    }
    return pending;
  }
}

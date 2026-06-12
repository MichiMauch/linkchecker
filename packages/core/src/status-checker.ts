import { checkStatus, type FetchOptions } from "./fetcher.js";
import { hostOf, type Throttle } from "./throttle.js";
import { stripHash } from "./url.js";
import type { StatusResult } from "./types.js";

/**
 * Memoizes status checks for the lifetime of one crawl. Without this you'd
 * re-request popular external targets (twitter.com, fonts.googleapis.com, …)
 * hundreds of times and get rate-limited or banned.
 *
 * When given a {@link Throttle}, checks are also rate-limited per host.
 */
export class StatusChecker {
  private readonly cache = new Map<string, Promise<StatusResult>>();

  constructor(
    private readonly opts: FetchOptions = {},
    private readonly throttle?: Throttle,
  ) {}

  check(url: string): Promise<StatusResult> {
    const key = stripHash(url);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.throttle
        ? this.throttle.run(hostOf(key), () => checkStatus(key, this.opts))
        : checkStatus(key, this.opts);
      this.cache.set(key, pending);
    }
    return pending;
  }
}

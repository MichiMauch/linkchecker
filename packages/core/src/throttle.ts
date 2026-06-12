/** Per-host rate limiting so a single server is never hammered. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface ThrottleOptions {
  /** Max concurrent in-flight requests to the same host. */
  perHostConcurrency?: number;
  /** Minimum delay between request *starts* to the same host (ms). */
  minHostDelayMs?: number;
}

interface HostState {
  active: number;
  lastStart: number;
  waiters: Array<() => void>;
  delayMs: number;
}

/**
 * Limits concurrency and request spacing *per host*. The crawler's global
 * concurrency still applies on top; this ensures that even when everything is
 * on one domain (a single-site crawl) we stay polite.
 */
export class Throttle {
  private readonly hosts = new Map<string, HostState>();
  private readonly perHost: number;
  private readonly defaultDelay: number;

  constructor(opts: ThrottleOptions = {}) {
    this.perHost = Math.max(1, opts.perHostConcurrency ?? 3);
    this.defaultDelay = Math.max(0, opts.minHostDelayMs ?? 100);
  }

  /** Raise the minimum delay for one host (e.g. from a robots Crawl-delay). */
  setHostDelay(host: string, ms: number): void {
    const st = this.get(host);
    if (ms > st.delayMs) st.delayMs = ms;
  }

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const st = this.get(host);
    await this.acquire(st);
    try {
      return await fn();
    } finally {
      this.release(st);
    }
  }

  private get(host: string): HostState {
    let st = this.hosts.get(host);
    if (!st) {
      st = { active: 0, lastStart: 0, waiters: [], delayMs: this.defaultDelay };
      this.hosts.set(host, st);
    }
    return st;
  }

  private async acquire(st: HostState): Promise<void> {
    if (st.active >= this.perHost) {
      await new Promise<void>((resolve) => st.waiters.push(resolve));
    }
    st.active++;
    if (st.delayMs > 0) {
      const wait = st.lastStart + st.delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      st.lastStart = Date.now();
    }
  }

  private release(st: HostState): void {
    st.active = Math.max(0, st.active - 1);
    const next = st.waiters.shift();
    if (next) next();
  }
}

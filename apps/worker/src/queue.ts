import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** Shared connection for the queue and workers. */
export const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

export interface CrawlJob {
  runId: string;
  url: string;
  baseUrl: string;
}

export const CRAWL_QUEUE = "crawl";

export const crawlQueue = new Queue<CrawlJob, unknown, string>(CRAWL_QUEUE, { connection });

/** Redis key holding the set of already-seen URLs for a run (cross-worker dedup). */
export const seenKey = (runId: string): string => `seen:${runId}`;

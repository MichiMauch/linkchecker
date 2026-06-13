import { parseLangs } from "@linkchecker/core";

/** Tiny CLI flag parser shared by the run/seed entrypoints. */
export interface CliArgs {
  url?: string;
  sitemap?: string;
  base?: string;
  max: number;
  concurrency: number;
  noDb: boolean;
  perHost?: number;
  delay?: number;
  noRobots: boolean;
  /** Sitemap subset by <lastmod>: check only the newest/oldest N entries (seeds-only). */
  select?: { order: "newest" | "oldest"; limit: number };
  /** Sitemap subset by <lastmod> date window (seeds-only). Combinable with select. */
  dateRange?: { from?: string; to?: string };
  /** Restrict the crawl to these language codes (URL path /xx/). Empty = all. */
  langs?: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    max: Number.POSITIVE_INFINITY,
    concurrency: 10,
    noDb: false,
    noRobots: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--url":
        args.url = argv[++i];
        break;
      case "--sitemap":
        args.sitemap = argv[++i];
        break;
      case "--base":
        args.base = argv[++i];
        break;
      case "--max":
        args.max = Number(argv[++i]);
        break;
      case "--concurrency":
        args.concurrency = Number(argv[++i]);
        break;
      case "--no-db":
        args.noDb = true;
        break;
      case "--per-host":
        args.perHost = Number(argv[++i]);
        break;
      case "--delay":
        args.delay = Number(argv[++i]);
        break;
      case "--no-robots":
        args.noRobots = true;
        break;
      case "--newest":
        args.select = { order: "newest", limit: Number(argv[++i]) };
        break;
      case "--oldest":
        args.select = { order: "oldest", limit: Number(argv[++i]) };
        break;
      case "--from":
        args.dateRange = { ...args.dateRange, from: argv[++i] };
        break;
      case "--to":
        args.dateRange = { ...args.dateRange, to: argv[++i] };
        break;
      case "--lang":
        args.langs = parseLangs(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.url && !args.sitemap) {
    throw new Error("Provide --url <startUrl> or --sitemap <sitemapUrl>");
  }
  if (args.select) {
    if (!args.sitemap) throw new Error("--newest/--oldest require --sitemap");
    if (!Number.isFinite(args.select.limit) || args.select.limit <= 0) {
      throw new Error("--newest/--oldest need a positive number, e.g. --newest 100");
    }
  }
  if (args.dateRange) {
    if (!args.sitemap) throw new Error("--from/--to require --sitemap");
    for (const [flag, val] of [
      ["--from", args.dateRange.from],
      ["--to", args.dateRange.to],
    ] as const) {
      if (val !== undefined && Number.isNaN(Date.parse(val))) {
        throw new Error(`${flag} is not a valid date: "${val}" (use e.g. 2026-01-01)`);
      }
    }
  }
  return args;
}

/** True when the run targets only a slice of the sitemap (date window and/or top-N). */
export function isSubsetCrawl(args: CliArgs): boolean {
  return !!(args.select || args.dateRange);
}

/** Human-readable description of the active sitemap subset (for logging). */
export function describeSubset(args: CliArgs): string {
  const parts: string[] = [];
  if (args.dateRange) parts.push(`${args.dateRange.from ?? "…"} – ${args.dateRange.to ?? "…"}`);
  if (args.select) {
    parts.push(`${args.select.order === "newest" ? "neueste" : "älteste"} ${args.select.limit}`);
  }
  return parts.join(", ") || "Teilmenge";
}

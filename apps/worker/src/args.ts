/** Tiny CLI flag parser shared by the run/seed entrypoints. */
export interface CliArgs {
  url?: string;
  sitemap?: string;
  base?: string;
  max: number;
  concurrency: number;
  noDb: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    max: Number.POSITIVE_INFINITY,
    concurrency: 10,
    noDb: false,
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
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.url && !args.sitemap) {
    throw new Error("Provide --url <startUrl> or --sitemap <sitemapUrl>");
  }
  return args;
}

# linkchecker

Extensible site monitoring built around a simple idea: **fetch each page once,
run it through a list of analyzers.** The link checker is the first analyzer —
add SEO, GEO, performance or accessibility checks later by implementing the
same `Analyzer` interface, without touching the crawler.

## Architecture

```
Sitemap/Seed → Fetch (1× per page) → [ Analyzer: LinkChecker ]
                                      [ Analyzer: …later…     ]
                                            ↓
                                     findings + links → SQLite/Turso → Dashboard
```

- **`packages/core`** — fetch engine (manual redirect tracking), the
  `Analyzer` contract, the in-process crawler, sitemap parsing, and a cached
  HEAD→GET status checker.
- **`packages/analyzers`** — the `LinkChecker` (extracts `<a href>`, classifies
  internal/external, records edges, reports broken links + redirects).
- **`packages/db`** — Drizzle schema (`runs`, `pages`, `links`, `findings`) and
  a persistence sink. `findings.detail` is JSONB so new analyzers need no
  migration.
- **`packages/queue`** — shared BullMQ queue + Redis helpers (seed, per-run
  completion counter, liveness ping). Used by both the dashboard (enqueue) and
  the worker (consume) so neither app depends on the other.
- **`apps/worker`** — two entrypoints sharing the same `processPage` core:
  - `run.ts` — single-process crawl (great for dev / small sites)
  - `seed.ts` + `worker.ts` — distributed crawl over BullMQ/Redis (scales to
    100k+ URLs across processes/machines; frontier deduped via Redis `SADD`)

## Quick start

No database server, no Docker. The DB is a SQLite file (`linkchecker.db`)
created automatically at the repo root on first run.

```bash
npm install

# Crawl — writes results to the local DB file automatically
npm run crawl -- --url https://your-site.com --max 1000
# ...or seed from a sitemap:
npm run crawl -- --sitemap https://your-site.com/sitemap.xml

# View results in the browser
npm run dashboard             # → http://localhost:3000
```

That's it. Add `--no-db` to the crawl for a pure console dry-run with no writes.

### Production (Turso)

Same code, same queries — just point at a hosted libSQL database:

```bash
export DATABASE_URL=libsql://your-db.turso.io
export DATABASE_AUTH_TOKEN=your-token
npm run crawl -- --sitemap https://your-site.com/sitemap.xml
```

### Distributed crawl (very large sites, optional)

By default the dashboard crawls **in-process** — zero infra, but a server
restart mid-crawl aborts the run. For 100k+ URLs, restart-safety, and
horizontal scaling, switch to **worker mode**: the dashboard only enqueues
jobs and separate worker process(es) do the crawling. This is the only mode
that needs Redis.

From the CLI:

```bash
docker compose up -d redis
npm run seed   -- --sitemap https://your-site.com/sitemap.xml
npm run worker                # start as many as you like, even on other machines
```

From the dashboard (the "Crawl starten" button enqueues instead of crawling
in-process):

```bash
export USE_WORKER=true
export REDIS_URL=redis://localhost:6379
npm run worker      # in one process/container
npm run dashboard   # in another
```

The worker tracks per-run completion in Redis and marks the run `done` when
the queue drains. If `USE_WORKER` is unset, or Redis is unreachable, the
dashboard silently falls back to in-process crawling.

## Why these choices (Next.js + Drupal site)

- **Static HTML fetch, no headless browser.** Next.js renders `<a href>` into
  the initial HTML (SSR/SSG), so `undici` + `cheerio` see all the links. Only
  add Playwright for specific client-rendered pages.
- **Seed from Drupal's sitemap.** No blind crawl-frontier needed — the sitemap
  is the canonical URL list. The crawler still discovers links per page to
  catch anything missing from the sitemap.
- **External links are deduped + cached** (`StatusChecker`) so a popular
  external target is requested once per run, not thousands of times.

## Adding a new analyzer

```ts
import type { Analyzer, AnalyzerResult, CrawlContext, FetchedPage } from "@linkchecker/core";

export class SeoAnalyzer implements Analyzer {
  name = "seo";
  async analyze(page: FetchedPage, ctx: CrawlContext): Promise<AnalyzerResult> {
    // inspect page.body, return { findings, discoveredUrls: [], links: [] }
    return { findings: [], discoveredUrls: [] };
  }
}
```

Register it in the analyzer list in `apps/worker/src/run.ts` / `worker.ts`.
Its findings land in the same `findings` table, tagged by `analyzer`.

## Politeness (rate limiting & robots.txt)

Crawls are polite by default: per-host concurrency is capped, requests to the
same host are spaced out, and `robots.txt` is fetched per origin (disallow
rules are honored, `Crawl-delay` raises the per-host delay). Tune via CLI:

```bash
npm run crawl -- --url https://your-site.com \
  --per-host 3 \      # max concurrent requests to one host (default 3)
  --delay 100 \       # min ms between requests to one host (default 100)
  --no-robots         # ignore robots.txt (default: respect it)
```

In code, pass a `politeness` block to `runCrawl({ politeness: { … } })`.

## Roadmap / next steps

- Incremental crawls (sitemap `lastmod` diff + rotating external recheck)
- Cross-worker external-status cache in Redis
- Alerts (email/Slack) when new broken links appear between runs
- Scheduling (BullMQ repeatable jobs or cron)

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

For 100k+ URLs across multiple worker processes/machines, use the BullMQ
worker. This is the only mode that needs Redis:

```bash
docker compose up -d redis
npm run seed   -- --sitemap https://your-site.com/sitemap.xml
npm run worker                # start as many as you like
```

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

## Roadmap / next steps

- Next.js dashboard (`apps/dashboard`) — broken-link report, trends across runs
- Incremental crawls (sitemap `lastmod` diff + rotating external recheck)
- Per-host rate limiting & `robots.txt` politeness
- Cross-worker external-status cache in Redis
- Alerts (email/Slack) when new broken links appear between runs
- Scheduling (BullMQ repeatable jobs or cron)

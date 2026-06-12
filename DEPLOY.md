# Deployment (Coolify)

The database is **Turso** (already hosted) — no DB to deploy. Two ways to run:

## Option A — Web only (in-process crawling)

Simplest. One container, no Redis. The dashboard crawls inside its own process.
Good for moderate sites; a redeploy/restart mid-crawl aborts the run.

- **Build pack:** Dockerfile
- **Dockerfile:** `apps/dashboard/Dockerfile`
- **Build context / base dir:** repo root (`/`)
- **Port:** `3000`
- **Env:**
  - `DATABASE_URL=libsql://linkchecker-netnode-ag.turso.io`
  - `DATABASE_AUTH_TOKEN=<turso token>`
  - (leave `USE_WORKER` unset)

## Option B — Full stack (web + worker + redis)

Restart-safe and scalable. The dashboard enqueues; a separate worker crawls.

- **Build pack:** Docker Compose
- **Compose file:** `docker-compose.coolify.yml`
- **Env:**
  - `DATABASE_URL=libsql://linkchecker-netnode-ag.turso.io`
  - `DATABASE_AUTH_TOKEN=<turso token>`
  - (`USE_WORKER`, `REDIS_URL` are set inside the compose)

Coolify assigns the public domain to the `web` service (`SERVICE_FQDN_WEB_3000`).

## Notes

- **Auto-deploy:** Coolify rebuilds on every push to `main` (GitHub webhook).
- **Schema:** tables are auto-created on first DB connection — no migration step.
- **Secrets:** never commit the Turso token; set it in Coolify's env settings.
- **Auth:** the dashboard has no authentication — anyone with the URL can start
  crawls. Put it behind access control if it must not be public.

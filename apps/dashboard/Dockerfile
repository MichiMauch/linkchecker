# syntax=docker/dockerfile:1
# Next.js dashboard — lean standalone image. Build context = repo root.

FROM node:22-alpine AS base
WORKDIR /app

# --- build: install + produce .next/standalone in one stage so that whatever
# npm hoists/nests (e.g. Next 16 may nest `next` under apps/dashboard) is all
# present when the build runs. ---
FROM base AS build
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/ai/package.json ./packages/ai/
COPY packages/analyzers/package.json ./packages/analyzers/
COPY packages/db/package.json ./packages/db/
COPY packages/queue/package.json ./packages/queue/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/worker/package.json ./apps/worker/
RUN npm ci
COPY . .
RUN npm run build -w @linkchecker/dashboard

# --- runner: only the standalone server + static assets ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/apps/dashboard/.next/standalone ./
COPY --from=build /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build /app/apps/dashboard/public ./apps/dashboard/public
# libsql loads its native binding via a DYNAMIC require that Next's standalone
# file tracing can't follow, so the platform package is missing. Copy the whole
# @libsql + libsql trees in explicitly (arch-agnostic).
COPY --from=build /app/node_modules/@libsql ./node_modules/@libsql
COPY --from=build /app/node_modules/libsql ./node_modules/libsql
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]

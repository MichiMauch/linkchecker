# syntax=docker/dockerfile:1
# Next.js dashboard — lean standalone image. Build context = repo root.

FROM node:22-alpine AS base
WORKDIR /app

# --- deps: install with the full workspace manifest set ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/analyzers/package.json ./packages/analyzers/
COPY packages/db/package.json ./packages/db/
COPY packages/queue/package.json ./packages/queue/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/worker/package.json ./apps/worker/
RUN npm ci

# --- build: produce .next/standalone ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
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
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]

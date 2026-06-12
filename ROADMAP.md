# Roadmap & deferred decisions

## ⚠️ Deferred decision — Fix export target (DO NOT FORGET)

**When building Phase 3 (the "Redirect-Map / fix export" step), decide the export target:**

- `next.config` redirects
- nginx config
- Netlify-style `_redirects`
- **Drupal write-back** (via JSON:API)

**Why this matters / the non-obvious part:** most broken internal links live in
**CMS content (Drupal), not in code**. A generated redirect file or a code PR
therefore only fixes a fraction. The highest-value — but biggest — option is
**writing the corrected link back into the Drupal content via its API**. That is
a real integration, not a template. Weigh effort vs. value at that point; do not
default to "just emit a redirects file" without considering the Drupal path.

Raised 2026-06-12 while scoping the AI features (Soft-404 + fix suggestions).

## AI features

- **Phase 1 — Soft-404 detection** (in progress): pages that return HTTP 200 but
  are "not found" templates. Probe + heuristics (deterministic) + OpenAI
  gpt-5.1-mini fallback for the ambiguous band.
- **Phase 2 — Fix suggestions** for broken internal links: lexical prefilter →
  LLM ranks one candidate from the known-good URL set (on-demand, cached).
- **Phase 3 — Fix export** (see deferred decision above).

## Other backlog

- Auth in front of the dashboard (before exposing more AI/content-fetching).
- Alerts on newly-broken links between runs (set-diff, not AI).
- Importance weighting via Matomo pageviews.

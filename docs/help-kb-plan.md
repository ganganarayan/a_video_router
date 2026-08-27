# Help / Knowledge Base — plan

In-app help so tenant users (owner + staff) can self-serve answers about every feature.

## Phase 1 — In-app Help Center  ✅ DONE (local, 2026-08-27)
- `/help` route (via `pages` map in `src/web/server.js`) — gated `requirePageAuth + resolveTenant + requireTenant`, so any logged-in tenant user can see it.
- Nav "Help" tab in `src/web/views/partials/head.ejs`.
- `src/web/views/help.ejs` — content-driven KB: articles as a `KB[]` array grouped by
  category (Getting started, Connections, Routing, Sources & manual push, Schedules,
  Runs & logs, Billing & wallet, Team & permissions, Troubleshooting).
- Client-side search (filters + highlights, auto-expands matches) and native
  `<details>` accordions. **No backend / no API / no migration.**
- Verified: EJS render smoke test + full `node --test` (52 pass).
- NOT deployed to staging/prod yet (Railway-only verification pref — awaiting user go).

## Phase 2 — Contextual + public KB  (not started)
- Per-page "?" links that deep-link into the relevant article (`/help#article-id`).
- Public (anonymous) KB subset, linked from the landing-page FAQ.
- Super-admin editable article content (app_config-driven) so copy changes need no redeploy.

## Phase 3 — Support + feedback  (not started)
- "Contact support" form → email + a `support_tickets` table (migration + API).
- "Was this helpful?" per article; basic search-term analytics.

## Notes
- Keep article copy accurate to SHIPPED features only. When a feature changes, update
  the matching `KB[]` entry in `help.ejs` (Phase 1) — no other moving parts.
- Token estimate vs actual for each phase is tracked in `docs/token-estimates-ledger.md`.

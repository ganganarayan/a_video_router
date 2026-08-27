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

## Phase 2 — Contextual + public KB
- ✅ **A — Contextual "?" deep-links (DONE 2026-08-27):** stable article ids in `help.ejs`
  (`id:` on anchor articles, slug fallback for the rest); `/help#<id>` opens + scrolls +
  flashes the article (`openHash` + `.kb-flash`). A floating "?" help button (`.help-fab`)
  is injected by `partials/head.ejs` via a `HELP_MAP` of page→article-id (connections→
  connect-zoom, routing, sources→push-single, schedules, runs/logs→runs, billing, team,
  settings→getting-started).
- ✅ **B — Public anonymous FAQ (DONE 2026-08-27):** new `/faq` route (public, no auth) +
  `views/faq.ejs` — standalone dark-theme page, own search + accordions, 9 prospect-facing
  Q&As, beacon.js included. Linked from the landing-page footer. `/faq` classified as `kb`
  in the tracking module (`track.js` classifySection).
- ❌ **C — Super-admin editable content (CMS):** user opted OUT (2026-08-27). Articles stay
  hardcoded in `help.ejs` / `faq.ejs`; edit those files + redeploy to change copy.

## Phase 3 — Support + feedback  (SKIPPED per user, 2026-08-27)
- Not built. Existing `/contact` page (email + WhatsApp) covers support. No `support_tickets`
  table, no helpful-votes, no search-term analytics. Revisit if needed later.

## Notes
- Keep article copy accurate to SHIPPED features only. When a feature changes, update
  the matching `KB[]` entry in `help.ejs` (Phase 1) — no other moving parts.
- Token estimate vs actual for each phase is tracked in `docs/token-estimates-ledger.md`.

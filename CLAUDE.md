# AVideoRouter — project instructions

## UI work

Before any change that touches UI, read `UI-STRICTURES.md` at the repo root in
full. It overrides your defaults. Do not introduce a colour, font size, spacing
value or radius that is not defined there.

The design tokens live in `src/web/public/tokens.css` and are the only source of
colour, size, spacing and radius. `src/web/public/style.css` holds the shared
primitives built on them. Neither a template nor a stylesheet may contain a
literal colour — if a change needs a value that is not in tokens.css, add it
there first, in both themes, with a reason.

The strictures were written from an audit of a sibling product, Assess360, and
are adopted here with these differences:

- **The brand is AVideoRouter blue, not Assess360's green.** Every other rule in
  section 1 — token names, both themes authored explicitly, no literal colours —
  applies unchanged.
- **No sidebar.** Section 8 applies to the top nav: sticky header, active and
  hover differing by two properties, an account menu holding Log out, and an
  off-canvas drawer below 900px.
- **Sections 12 and 13 have no equivalent here** — there is no long-form builder
  and no respondent flow. If either appears, the rules apply as written.
- **Section 11's ban on native selects is met by restyling, not replacement.**
  The native control keeps its behaviour and keyboard support; only its chrome is
  replaced, so it matches the product in both themes.
- **Section 8.6 (no support address in the footer) is deliberately not applied.**
  It follows from Assess360 being a no-face product; AVideoRouter brands itself
  openly as an app by Divine Leads and the address is intentional.
- **This is a server-rendered EJS app**, not React/Tailwind/shadcn. "Component"
  means a template partial or a class in `style.css`.

A UI change is done when both themes are correct at 375, 768 and 1280, there is
no horizontal page scroll, focus states are present, contrast is checked, and
the empty, loading and error states exist.

## Dates and times

Everything a person reads is DD-MM-YYYY (and `DD-MM-YYYY HH:MM`, 24-hour) in
IST, via `fmtDate` / `fmtDateOnly` in `src/web/public/app.js`, which compute from
a fixed +05:30 offset. Never call `toLocaleString()` / `toLocaleDateString()`
without a locale — it renders US month-first order on Railway and for most
visitors. Money and counts use `'en-IN'`. Machine-facing fields (JSON, API
payloads, DB columns) stay ISO-8601 UTC.

## Pages

The Transfers page (`src/web/views/transfers.ejs`, route `/transfers`) was called
Sources until October 2026; `/sources` still 301s to it, and the `/api/sources/*`
endpoints kept their original names.

<!-- standing-rules:begin (shared across every repo; edit here and it is copied, do not reword per repo) -->
## Standing instructions

These used to live only on the owner's Windows PC, so a cloud session never saw
them. They are committed here on purpose: a cloud session starts from a fresh
clone and gets nothing that was only configured on a machine.

### Branching and environments

- Exactly two long-lived branches: **main** (production line) and **orbitq**
  (staging). Never master; if a repo still has one, rename it to main.
- The staging branch is always named orbitq and the staging service is the
  *-staging service.

### Build and deploy: auto-push to staging, never build locally

- **Auto-push to staging without asking.** Anything built or changed goes to the
  staging branch automatically: commit and push as the final step of the work,
  then verify on staging. Do not ask whether to push. Main/prod stays gated.
- **No builds in the session, local or cloud.** Never next build, docker or
  npm run build, never start the server, never rely on "it works in my
  sandbox". The Railway environment differs from a laptop *and* from a cloud
  container, so a passing run in the session proves nothing about production.
  Write the code to the files; the app is verified on staging.
  (prisma generate for codegen and tsc --noEmit for a typecheck are allowed:
  they compile and verify types, they do not build or run the app. Unit tests
  are fine too.)
- **Static syntax-check every changed file before committing** (this is not a
  build): node --check for changed JS/MJS, an EJS compile check for changed
  templates, a typecheck for TypeScript projects. A syntax or type error must
  never reach a staging commit.
- Flow: commit to staging, deploy staging, verify on the live staging URL
  (GET /api/version matches the pushed SHA). Then, **only when the owner
  explicitly says so**, fast-forward main, deploy prod, verify. "Push to main"
  means that whole flow; never touch main or prod unprompted.
- No exceptions and no editorialising. Do not decide a change is a runtime
  no-op and skip the push. Consistency over cleverness.

### Deploy polling

Record each build's duration. On the next deploy do not start polling at once:
wait about (last build duration + 10 seconds) before the first status check,
then poll at modest intervals until it is Online. Most of the build window
should carry zero polls.

### Status colours and formatting

- Signal state with coloured dots: 🟢 green = OK / success / safe,
  🟡 yellow = not OK / needs attention / caution, 🔴 red = dangerous /
  destructive / blocked.
- The owner's chat theme renders inline code spans in red, which reads as
  danger. Avoid backticks for branch names, file paths, commit hashes and
  commands written in prose: use plain text, bold, or markdown file links.
  Keep backticks for real code and copy-paste commands.

### Dates and times: Indian format everywhere

- Every timestamp a human reads is DD-MM-YYYY, and DD-MM-YYYY HH:MM (24-hour)
  when the time matters. UI, tables, exports, CSV columns, PDFs, emails,
  WhatsApp, logs people read. MM-DD-YYYY is never acceptable.
- **Never leave the locale to the runtime.** toLocaleString() or
  toLocaleDateString() with no locale, or with undefined, renders in the
  server's or browser's locale, which on Railway is US order. Never ship a bare
  one: always go through the project's own formatter.
- Times are IST (UTC+05:30) computed from a fixed offset, not from the host's
  timezone (the server runs UTC). A new project gets the same formatter helper
  before its first date is rendered.
- Machine-to-machine fields (JSON payloads, APIs, DB columns, round-trip export
  bodies) stay ISO-8601 UTC. This rule is about what a person reads.

### Configuration lives in the app, not in env

All user- and tenant-scoped configuration (SMTP and email keys, API keys,
sheets, schedules) lives in the app's own settings UI and its tenant config
table. Environment variables are only for platform infrastructure. A cloud
session has no .env and does not need one: do not ask for keys, and do not add
an env var for something the settings UI owns.

### Writing

- **No em dashes.** Never write the U+2014 character in code, UI text, commit
  messages or chat. Grep the changed files before committing.
- Be concise. End every reply with a token footer: this-turn in and out
  (estimated), cumulative, context-window fullness, and a continue-versus-new-chat
  nudge. Before a task or phase, give a tentative token estimate, proceed
  without asking, then log estimate against actual and calibrate (gut estimates
  run about 2 to 3 times the objective per-turn counter).
<!-- standing-rules:end -->

### This repo

Staging branch: orbitq. Production branch: main.

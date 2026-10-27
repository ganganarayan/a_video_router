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

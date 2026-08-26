# VideoRouter — Build Status

_Last updated: 2026-08-25_

## What it is
A multi-tenant SaaS that **automatically routes recordings from Zoom & Fathom → YouTube & an LMS**, hands-free. Sold to tenant admins (coaching institutes, course creators, educators); operated by a super admin (platform owner). Pay-as-you-go wallet billing.

- **Sources:** Zoom, Fathom
- **Destinations:** YouTube channel(s), LMS (push via API)
- **Core value:** eliminates the 15–30 min/recording manual grind (download → upload → title/privacy → file into course → delete from Zoom); runs on a schedule with full logs.

## Tech stack & deployment
- Node 22 (ESM), Express, raw `pg` (no ORM), EJS server-rendered views, bcryptjs, JWT cookie sessions.
- Hosted on **Railway** (Docker, `node:22-slim` + ffmpeg). Postgres on Railway.
- Two environments: **prod** (`videorouter`, branch `master`) and **staging** (`videorouter-staging`, branch `orbitq`), deployed via `npm run deploy:prod` / `deploy:staging` (guarded scripts refuse wrong branch / dirty tree).
- Self-service DB backup/restore via `/dbadmin/export` + `/dbadmin/import` (Hobby plan has no managed backups), gated by `PASSWORD_RESET_KEY`.

---

## ✅ Built

### Core pipeline (single-tenant original, now multi-tenant)
- Zoom & Fathom ingest, rule-based routing to YouTube (+ playlists, title/privacy/description), optional LMS push.
- Per-file **manual push** with live transfer telemetry (speed/ETA/progress/log).
- **Multi-schedule** system (daily/cron per tenant); dashboard **run logs**.
- **Delete from Zoom** from the dashboard (no Zoom sign-in), only after a verified YouTube upload. Deletion is manual-only.
- Retry/resume, cached downloads, states machine.

### Phase 1 — Multi-tenancy + roles _(LIVE on prod)_
- `tenants`, `users` (roles), per-tenant scoping on every domain table; migrations 004/005.
- Roles mirror Assess360: **super_admin** (global, behind `/admin`), **admin** (tenant owner), **staff** (view/edit).
- **Super admin operates via impersonation** (read-only all-tenant view + "Impersonate" into any tenant).
- **Passwordless first login** + forced password change (super admin + tenant admins).
- **Staff provisioning** — owners add staff with view/edit permissions (Team page).
- No subdomains per tenant — slug = username; super admin at `/admin`.
- Flipped to prod 2026-08-25: existing data (16 recordings, 2 channels, Zoom, Fathom, schedule) migrated under Tenant #1 **"Apply Gita"**; verified, zero loss.

### Phase 2 — Wallet billing _(built + validated on staging; NOT yet on prod)_
- **Pay as you go: ₹50/video** (up to 1 GB; >1 GB = 2 units). **First upload free** per tenant.
- **Wallet** with strict pre-push gate (balance must be > 0), but an **in-flight upload always finishes** and may go negative — settled on next top-up. Deduction is at **runtime by actual file size**.
- **Top-up in packs of 10 videos** (10/20/30 presets + validated custom field, multiples of 10 only). Amount = base + **18% GST** + **2.5% gateway fee**; wallet credited the base only. (e.g. ₹500 → ₹604.75.)
- **"Pay as you go" modal** with in-situ calculation; invalid amounts never reach the gateway.
- **Super-admin controls:** adjust any wallet, toggle a tenant "unmetered" (Apply Gita is unmetered so the owner isn't billed), set gateway keys.
- GST invoices issued by the owner from their CRM (not in-app).
- Append-only ledger (`wallet_txns`), `payments` audit table.

### Payments — multi-gateway _(schema for all 3; Razorpay working)_
- **Razorpay:** fully working (in-page Checkout modal). Verified on staging — creates real orders with the owner's test keys.
- **Schema + admin UI ready for Easebuzz & PhonePe** (migration 007 generic `payments` columns + `payment_provider` switch). Active-gateway selector on `/admin`.
- Keys stored **encrypted** in `app_config`, set from `/admin` (no redeploy).

### Landing page _(built + live on staging; NOT yet on prod)_
- Public marketing site at `/` (visitors) — logged-in users redirect into the app.
- Sections: hero → **configurable hero video** → speed banner (1 GB ≈ 90s) → problem → 3-step how-it-works → features → pricing → FAQ → CTA.
- **Hero video URL is set from `/admin`** ("Landing page video" card) and read live — swap the VidaPulse embed anytime, no redeploy. Blank hides it.
- Positioning brief: `docs/landing-brief.md`.

---

## 🔜 Planned / pending

### Immediate
- **Live Razorpay browser test** on staging (test card) to confirm wallet credit end-to-end.
- **Flip Phase 2 (billing) + landing page to prod** — safe; billing stays dormant until live Razorpay keys are entered on prod `/admin`.
- **Custom domain** `vr.divineleads.guru` (single host: landing at `/`, app behind `/login`, Razorpay Checkout on the approved subdomain). DNS CNAME → Railway; then set `PUBLIC_URL`, update Google OAuth redirect URIs + Razorpay webhook. _(User adding the domain now.)_

### Payment gateways (accounts activating)
- **PhonePe adapter** (~48h to account activation): OAuth token → `/checkout/v2/pay` PayPage redirect → Order-Status + webhook.
- **Easebuzz adapter** (~1 week): SHA-512 hashed `initiateLink` → hosted redirect → reverse-hash verify + webhook.
- Both are hosted-redirect flows; the Billing page already handles redirect mode. Zero-MDR gateways → set `gateway_percent = 0` (config knob, no code change).

### Performance
- **Fathom download speed-up** — Fathom serves HLS (many small segments); current ffmpeg pull disables keep-alive and fetches sequentially → slow (10+ min). Plan: add **yt-dlp with parallel fragments** (+ keep-alive test), and set `CACHE_DIR` to a mounted volume for large files. Runs server-side (not affected by the user's internet). Needs a real recording to benchmark.

### Product / go-live
- **LMS ingest go-live** — `src/providers/lms.js` follows the myappz.ai spec but the endpoint isn't live yet; rows stay `pending` and back-fill once an LMS account is connected.
- **Tenant onboarding** — a super-admin "create tenant + admin" flow (tenants currently created only via migration) — needed before selling to paying customers.
- **Naming decision** — considering a catchier brand (e.g. Reelay / ClassCast / PostPilot) vs. keeping "VideoRouter".
- **Landing copy polish** + optional additional gateways once live.

---

## Pricing model (summary)
| Item | Value |
|---|---|
| Per video (≤1 GB) | ₹50 |
| Over 1 GB | 2 units (₹100) |
| First upload | Free (per tenant) |
| Minimum top-up | 10 videos (₹500) |
| Top-up increments | Packs of 10 videos |
| GST | 18% (added on top) |
| Gateway fee | 2.5% on (base + GST); configurable per gateway |
| Wallet credit | Base amount only (fees/GST not credited) |
| Invoicing | GST invoice issued by owner from CRM |

## Key constraints / notes
- Prod DB not reachable from the dev machine (network blocks Railway's Postgres proxy) → all DB ops go through app endpoints (`/dbadmin`, admin UI).
- Deploys are CLI-driven (not GitHub-linked); prod redeploy clears the in-memory push queue (drain first).
- Apply Gita (owner's own tenant) is **unmetered** so billing never blocks the owner's own use.

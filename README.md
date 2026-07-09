# VideoRouter

A single always-on service that, on a schedule:

1. pulls new recordings from **Zoom** (screen-share + speaker view MP4 only) and **Fathom** (composited HLS → mp4 via ffmpeg),
2. routes each by its **title tag** to the right **YouTube channel + playlist** (unlisted, resumable upload),
3. pushes the YouTube link into your **myappz.ai LMS** as a lesson (optional — dormant until connected),
4. records every video + link in **Postgres** (your automatic link-log),
5. lets you **manually delete** a Zoom source from the dashboard once it has a verified YouTube link (never automatic; Fathom is never deleted — its API is read-only and storage unlimited),
6. and emails you a run summary.

Everything is managed from a JWT-protected **admin dashboard**: `/runs`, `/connections`, `/routing`, `/settings`. All provider credentials are stored **AES-256-GCM-encrypted in Postgres** — only six bootstrap environment variables exist.

## Environment variables (the only six)

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Railway injects it) |
| `SETTINGS_ENCRYPTION_KEY` | 32-byte hex key for encrypting stored secrets — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_SECRET` | signs dashboard sessions — generate the same way |
| `PUBLIC_URL` | the deployed base URL, e.g. `https://videorouter.up.railway.app` (no trailing slash) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first-run admin login (change the password in Settings after first login) |

## Deploy to Railway

1. Push this repo to GitHub, then in Railway: **New Project → Deploy from GitHub repo**. Railway detects the `Dockerfile` (Node 22 + ffmpeg) automatically.
2. In the project, **+ New → Database → PostgreSQL**. On the service, add a variable reference so `DATABASE_URL` points at it (Railway usually offers `${{Postgres.DATABASE_URL}}`).
3. Set the remaining five env vars. For `PUBLIC_URL` there is a **chicken-and-egg**: you don't know the domain until the service exists —
   1. deploy once (any placeholder `PUBLIC_URL`, e.g. `https://example.com`),
   2. **Settings → Networking → Generate Domain** on the service,
   3. set `PUBLIC_URL` to that exact `https://…` domain → Railway redeploys,
   4. only **then** connect YouTube channels (the OAuth callback depends on it).
4. Open `https://<your-domain>/health` → `{ "ok": true }`. Migrations and the admin user are created automatically on boot (both idempotent).
5. Log in at `https://<your-domain>/login` with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## One-time setup (from the dashboard)

### Zoom (Connections → Zoom)
Create a **Server-to-Server OAuth** app at marketplace.zoom.us with scopes `cloud_recording:read` **and** `cloud_recording:write` (write is required for delete). Also make sure the account setting that allows recording deletion is on. Paste Account ID / Client ID / Client Secret → **Save** → **Test connection**.

### Fathom (Connections → Fathom)
Paste your Fathom API key → Save → Test. The org setting **"disable recording download" must be OFF**.

### YouTube channels (Connections → YouTube)
Per channel (each gets its **own Google Cloud project** for quota isolation):

1. In Google Cloud Console: create a project → enable **YouTube Data API v3** → configure the OAuth consent screen (**Published**, not Testing — Testing refresh tokens expire in 7 days) → create an **OAuth client ID** (Web application).
2. Add the authorized redirect URI shown on the Connections page: `{PUBLIC_URL}/oauth/youtube/callback`. **The connect step 400s without this.**
3. In the dashboard: **Add channel** (label + client ID + secret) → you're sent to Google consent → **pick the exact channel** → done. The channel ID/handle and refresh token are stored on that row; uploads for a rule always use its own channel's token.

### LMS (Connections → LMS) — later, when myappz.ai ships the ingest endpoint
Paste the base URL + API key from the myappz.ai team → Save → Test. Until then leave it unconfigured: uploads are held at `lms_status = pending` and are pushed automatically on the first run after you connect (idempotent via `external_id`, so nothing duplicates). Set each rule's **LMS course ID / module ID** in Routing.

### Routing (Routing page)
Example rules:

| Pattern | Channel | Playlist | Privacy |
|---|---|---|---|
| `Hindi` | @ganganarayandas1977 | Hindi | unlisted |
| `Online - Gita Certification` | @GangaNarayanDas1 | Gita Certification | unlisted |
| `Online - 5 Day` | @GangaNarayanDas1 | 5 Day | unlisted |
| `Online - 90 Day` | @GangaNarayanDas1 | 90 Day | unlisted |

Matching is case-insensitive; lowest priority number wins, then the longest pattern. A title matching **no** rule is held as `skipped_no_route` — never uploaded to a wrong channel, never deleted — and processes automatically once you add a rule.

### Settings
Rolling window (default 3 days), **manual delete method** (`trash` / `delete` — used by the Sources-page Delete button; deletion is never automatic), and the Gmail address + **app password** for the run-summary email. Recurring run times live on the **Schedules** page. Press **Run now** on the Runs page any time.

## Safety model (why nothing breaks in between)

- **Dedupe:** unique `(source, source_id)` — a recording is never processed twice.
- **Manual delete, gated on verify:** the pipeline never deletes a Zoom source. You delete from the Sources page, and the button is inactive until the row holds a **non-null YouTube video ID** — so a source can never be deleted before its durable YouTube copy exists.
- **Missing view:** no `shared_screen_with_speaker_view` MP4 → `skipped_no_matching_view`, no guessing, no deleting.
- **LMS never blocks:** a failed LMS push marks `lms_status=failed` and retries next run; YouTube is the durable copy the LMS only links to.
- **Resumable uploads** (survives network blips mid-upload), ffmpeg reconnect flags for Fathom's redirect-to-GCS chunk hosts, sequential processing, temp files removed in `finally`.

## YouTube quota reality

`videos.insert` costs 1,600 units of the 10,000/day default per Google project → **~6 uploads/day per channel** (each channel has its own project). On a heavy backfill day, extra videos are parked in `error` and complete on following days — that's the design working, not failing. Need more? Request a quota increase in that channel's Google project.

## Branches & deploys

| Branch | Railway service | Command |
|---|---|---|
| `master` (production) | `videorouter` | `npm run deploy:prod` |
| `orbitq` (staging) | `videorouter-staging` | `npm run deploy:staging` |

The deploy scripts refuse to run from the wrong branch or with uncommitted changes
(`railway up` ships the working directory, not a git ref). Staging has its own
Postgres, secrets, and domain — connect test accounts there, never production ones.

## Develop / test locally

```bash
npm install
npm test        # unit tests: routing, crypto, Zoom UUID encoding, ffmpeg args, LMS payload, delete guard
```

Running the full service locally needs Postgres and ffmpeg (the Railway image includes both). Copy `.env.example` → `.env` values into your environment and `npm start`.

## Layout

```
migrations/           SQL migrations (run automatically on boot)
src/index.js          boot: migrate → seed → admin bootstrap → web + scheduler
src/providers/        zoom.js  fathom.js  youtube.js  lms.js
src/pipeline/         run.js (orchestrator)  router.js  download.js  states.js
src/scheduler.js      node-cron from app_config
src/notifier.js       run summary email (Gmail app password)
src/web/              Express + EJS dashboard (login, connections, routing, runs, settings)
test/                 node:test unit tests
```

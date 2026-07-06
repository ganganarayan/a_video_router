# Zoom + Fathom → YouTube Router — Full Design & Build Prompt

A single always-on Railway service (+ Postgres) that, on a schedule, pulls the
right video from Zoom and Fathom, uploads each to the correct YouTube channel by
tag, **pushes each into your myappz.ai LMS** (see the companion myappz.ai API
spec), records everything in a database, deletes the source from Zoom to free
space, and gives you an admin dashboard to run, watch, and keep an automatic
**link-log** of the whole thing — with all accounts connected from the
dashboard, not from environment variables.

---

## 1. Capability findings (verified against the live APIs)

| Requirement | Verdict | How |
|---|---|---|
| Delete Zoom recording after upload | ✅ Yes | `DELETE /v2/meetings/{uuid}/recordings?action=delete` (permanent) or `?action=trash` (recoverable). Reclaims the 10 GB. |
| Delete Fathom recording after upload | ❌ Not via API | Fathom's meetings API is **read-only**; only webhooks can be deleted. Fathom storage is **unlimited**, so there's no space pressure. Cleanup = Team-Edition auto-retention policy (time-based) or manual. |
| Pull only "screen share + speaker view" from Zoom | ✅ Yes | Each Zoom file has `recording_type`; select `shared_screen_with_speaker_view` + `file_type = "MP4"`. Ignore gallery/screen-only/etc. |
| Pull only speaker view from Fathom | ✅ N/A | Fathom outputs a single composited video (screen+speaker) at `<share_url>/video.m3u8`. Nothing to filter. |

---

## 2. Architecture

One Railway service, one Postgres database. No n8n, no queue broker, no second
runtime.

```
                ┌───────────────────────── Railway service ─────────────────────────┐
                │                                                                     │
 Scheduler ────►│  Puller (Zoom)      Puller (Fathom)                                 │
 (node-cron)    │      │                   │                                          │
                │      ▼                   ▼                                          │
                │   pick shared_screen   build <share>/video.m3u8                     │
                │   _with_speaker_view   (ffmpeg remux → mp4)                         │
                │      │                   │                                          │
                │      └───────┬───────────┘                                          │
                │              ▼                                                       │
                │          Router (tag → channel + playlist)                          │
                │              ▼                                                       │
                │          YouTube uploader (resumable, per-channel OAuth)            │
                │              ▼                                                       │
                │          Record in Postgres → delete Zoom source → log             │
                │                                                                     │
                │  Express web app  ── Admin dashboard (connect accounts, routing,   │
                │                       run history, manual run)                     │
                └─────────────────────────────────────────────────────────────────────┘
                                         │
                                    Postgres (creds encrypted, state, logs)
```

**Why scheduler-driven for both sources (not webhooks):** a missed webhook is a
lost video. A scheduled poll over a rolling window + database dedupe is
self-healing — anything not yet processed is picked up on the next run. This is
the choice that makes "nothing breaks in between" true.

### Components (all in the one service)
1. **Web/API server** (Express) — serves the dashboard + its API + `/health`.
2. **Scheduler** (node-cron) — fires the pull job on a configurable cron (default daily 23:00 IST). Also a manual "Run now" trigger from the dashboard.
3. **Zoom puller** — S2S token from DB → list recordings over rolling window → per meeting pick the `shared_screen_with_speaker_view` MP4 → dedupe → download → route → upload → record → delete source.
4. **Fathom puller** — API key from DB → list meetings over rolling window → get `share_url` → dedupe → ffmpeg-remux `<share_url>/video.m3u8` → route → upload → record. (No source delete — unlimited storage.)
5. **Router** — resolves a recording's tag to a YouTube channel + playlist from `routing_rules`.
6. **YouTube uploader** — resumable upload with per-channel OAuth refresh token; ensures/creates the playlist; adds the video.
7. **Downloader** — Zoom: authenticated stream to disk. Fathom: ffmpeg `-c copy` remux from HLS.
8. **Deleter** — Zoom only, **after** a verified upload.
9. **LMS pusher** — after a verified YouTube upload, POST the video (unlisted YouTube link + metadata + target course/module) to the myappz.ai LMS ingest endpoint; store the returned lesson id + link. Retryable, non-blocking.
10. **Notifier** — daily log email (nodemailer/Gmail app password) + full history in the dashboard.
11. **Postgres** — encrypted credentials, routing rules, processed-recording ledger, run logs, config.

---

## 3. Per-recording state machine (the anti-breakage core)

Every recording moves through states in `processed_recordings`. Nothing
destructive happens until the safe state is reached.

```
discovered → downloading → uploading → uploaded → lms_pushed → (zoom only) deleting → deleted
     │            │            │                                    
     └────────────┴────────────┴────────────► error (retried next run)
                                              skipped_no_route (needs a rule)
                                              skipped_no_matching_view (Zoom view missing)
```

Guarantees:
- **Dedupe:** unique key on `(source, source_id)`. A recording is never processed twice.
- **Delete-after-verify:** Zoom source is deleted **only** after YouTube returns a video ID for it. If upload fails, the source is untouched and retried.
- **No-route safety:** unknown tag → `skipped_no_route`, never uploaded to a wrong channel, never deleted. Surfaces in the dashboard; auto-processes once a rule exists.
- **Missing-view safety:** if a Zoom meeting has no `shared_screen_with_speaker_view` file, mark `skipped_no_matching_view`, do not guess, do not delete.
- **Idempotent retries:** any non-terminal state is safe to re-run (source still exists).
- **LMS push is a safe post-step:** the push to the myappz.ai LMS happens *after* the verified YouTube upload. If it fails it's marked `lms_status='failed'` and retried next run — it never blocks the upload or the Zoom delete, because YouTube is the durable copy the LMS only links to.
- **Resilience:** resumable YouTube upload (survives blips); ffmpeg reconnect flags (survives Fathom's redirect-to-GCS chunk hosts); sequential processing (no memory/CPU spikes).

---

## 4. Routing model

A recording's **tag** is matched against `routing_rules` to choose a channel +
playlist. Tag source = the meeting title/topic prefix (e.g. `Hindi`,
`Online - 90 Day`). Matching is case-insensitive "contains", most-specific
(longest pattern) first.

Example rules (editable in the dashboard):

| Source | Match pattern | → Channel | Playlist | Privacy |
|---|---|---|---|---|
| any | `Hindi` | @ganganarayandas1977 | Hindi | unlisted |
| any | `Online - Gita Certification` | @GangaNarayanDas1 | Gita Certification | unlisted |
| any | `Online - 5 Day` | @GangaNarayanDas1 | 5 Day | unlisted |
| any | `Online - 90 Day` | @GangaNarayanDas1 | 90 Day | unlisted |

Add a 3rd/4th channel later by adding rows — no code change.

---

## 5. Postgres schema

```sql
-- Provider credentials (secrets stored encrypted at the app layer, AES-256-GCM)
CREATE TABLE zoom_account (
  id            SERIAL PRIMARY KEY,
  account_id    TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  client_secret TEXT NOT NULL,          -- encrypted
  status        TEXT DEFAULT 'unverified',
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE fathom_account (
  id         SERIAL PRIMARY KEY,
  api_key    TEXT NOT NULL,             -- encrypted
  status     TEXT DEFAULT 'unverified',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE youtube_channels (
  id             SERIAL PRIMARY KEY,
  label          TEXT NOT NULL,         -- "Gita main", "Hindi"
  channel_id     TEXT,                  -- UC... (filled after OAuth)
  channel_handle TEXT,                  -- @GangaNarayanDas1
  google_email   TEXT,
  oauth_client_id     TEXT NOT NULL,    -- per-channel Google project (quota isolation)
  oauth_client_secret TEXT NOT NULL,    -- encrypted
  refresh_token  TEXT,                  -- encrypted, set by the OAuth connect flow
  status         TEXT DEFAULT 'disconnected',
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE lms_account (
  id         SERIAL PRIMARY KEY,
  base_url   TEXT NOT NULL,             -- myappz.ai LMS API base URL
  api_key    TEXT NOT NULL,             -- encrypted; bearer token issued by myappz.ai
  status     TEXT DEFAULT 'unverified',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE routing_rules (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'any',  -- 'zoom' | 'fathom' | 'any'
  match_type    TEXT NOT NULL DEFAULT 'contains', -- 'contains' | 'prefix' | 'regex'
  pattern       TEXT NOT NULL,
  channel_id    INTEGER REFERENCES youtube_channels(id),
  playlist_name TEXT,
  privacy       TEXT NOT NULL DEFAULT 'unlisted',
  keep_prefix   BOOLEAN NOT NULL DEFAULT true,   -- keep tag in the YouTube title
  lms_course_id TEXT,                            -- target LMS course for this tag
  lms_module_id TEXT,                            -- optional target module/section
  priority      INTEGER NOT NULL DEFAULT 100,
  enabled       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE processed_recordings (
  id             SERIAL PRIMARY KEY,
  source         TEXT NOT NULL,          -- 'zoom' | 'fathom'
  source_id      TEXT NOT NULL,          -- Zoom meeting UUID / Fathom recording_id
  source_file_id TEXT,                   -- Zoom recording file id (the mp4 we took)
  title          TEXT,
  matched_tag    TEXT,
  channel_id     INTEGER REFERENCES youtube_channels(id),
  youtube_video_id  TEXT,
  youtube_url    TEXT,                   -- final unlisted YouTube link (the "destination link")
  playlist_name  TEXT,
  lms_lesson_id  TEXT,                   -- returned by the myappz.ai LMS ingest endpoint
  lms_lesson_url TEXT,                   -- viewable lesson link inside the LMS
  lms_status     TEXT DEFAULT 'pending', -- 'pending' | 'pushed' | 'failed'
  status         TEXT NOT NULL DEFAULT 'discovered',
  file_size_bytes BIGINT,
  source_deleted BOOLEAN NOT NULL DEFAULT false,
  error_message  TEXT,
  discovered_at  TIMESTAMPTZ DEFAULT now(),
  uploaded_at    TIMESTAMPTZ,            -- timestamp shown in the dashboard log
  UNIQUE (source, source_id)
);

CREATE TABLE run_logs (
  id           SERIAL PRIMARY KEY,
  run_type     TEXT NOT NULL,            -- 'scheduled' | 'manual'
  started_at   TIMESTAMPTZ DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  found        INTEGER DEFAULT 0,
  uploaded     INTEGER DEFAULT 0,
  skipped      INTEGER DEFAULT 0,
  errors       INTEGER DEFAULT 0,
  summary      JSONB
);

CREATE TABLE app_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- seeded keys: cron_expression, timezone, rolling_window_days,
-- zoom_delete_mode ('off'|'trash'|'delete'), email_to, email_from

CREATE TABLE admin_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
```

---

## 6. Admin dashboard (pages)

1. **Login** — single admin (JWT session).
2. **Connections**
   - Zoom: fields for Account ID / Client ID / Client Secret + "Test connection".
   - Fathom: field for API key + "Test connection".
   - YouTube: list of channels; "Add channel" runs a Google OAuth flow (you pick the exact channel at consent → refresh token stored). Shows connected/disconnected + channel name.
   - LMS (myappz.ai): base URL + API key + "Test connection". Per-tag course/module IDs are set on each routing rule.
3. **Routing** — table of rules (tag → channel → playlist → privacy → LMS course/module); add / edit / delete / enable-disable / reorder priority.
4. **Runs / Overview (your video log + organizer)** — last run + next scheduled run + counts; and a searchable table of every processed recording with these columns, so you never hand-track YouTube again:
   - **Timestamp** (uploaded_at)
   - **File name** (title)
   - **Source** (zoom / fathom)
   - **YouTube link** — the final unlisted destination video link, captured automatically from the upload
   - **LMS lesson link** — where it landed in the LMS
   - **Status** + source-deleted?

   Plus a **"Run now"** button. This table is the organizer — every uploaded video's YouTube and LMS links are logged here on their own.
5. **Settings** — cron expression + timezone, rolling-window days, Zoom delete mode (off / trash / permanent), daily-log email to/from.

All accounts are connected here and stored encrypted in Postgres — **no provider secrets in environment variables.**

---

## 7. Bootstrap environment variables (the only ones)

```
DATABASE_URL             # Railway Postgres
SETTINGS_ENCRYPTION_KEY  # 32-byte key for AES-256-GCM of stored secrets
JWT_SECRET               # dashboard sessions
PUBLIC_URL               # e.g. https://videorouter.up.railway.app (OAuth callback base)
ADMIN_EMAIL              # first-run admin bootstrap
ADMIN_PASSWORD           # first-run admin bootstrap (change after login)
```

Everything else (Zoom, Fathom, YouTube, schedule, email) lives in the database
and is set from the dashboard.

---

## 8. Known external constraints (so nothing surprises you)

1. **YouTube upload quota — the one hard limit.** `videos.insert` costs 1,600
   quota units; the default per-Google-Cloud-project quota is 10,000 units/day
   → about **6 uploads/day per project**. Because the schema gives **each
   channel its own OAuth client (its own project)**, each channel gets its own
   ~6/day — enough for a few videos per channel per day. If any single channel
   needs more than ~6/day, either add another project or request a YouTube quota
   increase from Google. Hitting the cap returns `quotaExceeded`; the service
   marks those `error` and retries next run, so nothing is lost — it just waits.
2. **Fathom has no delete API** (covered above). Storage is unlimited, so this
   is a non-issue for space; only manual/retention cleanup exists if you want it.
3. **Zoom delete needs the write scope** (`cloud_recording:write`) on the S2S
   app, plus the account setting that allows recording deletion. The meeting
   **UUID must be double-URL-encoded** if it contains `/` or starts with `//`.
4. **Fathom "disable recording download"** org setting must be OFF (it is for
   your account — the m3u8 pull was verified working).

---

## 9. THE BUILD PROMPT (paste this into Claude Code)

> Build a production Node.js service that pulls videos from Zoom and Fathom on a
> schedule, uploads each to the correct YouTube channel by tag, records state in
> Postgres, deletes the Zoom source after a verified upload, and exposes an admin
> dashboard. Deploy target is Railway (Dockerfile-based; ffmpeg required).
>
> **Stack:** Node 18+ (ESM), Express, `pg` (Postgres), `googleapis`,
> `node-cron`, `nodemailer`, `jsonwebtoken`, `bcrypt`, native `crypto` for
> AES-256-GCM. Frontend: a lightweight React (Vite) SPA served by Express, or
> server-rendered EJS — pick the simpler to maintain. ffmpeg installed via the
> Dockerfile.
>
> **Secrets:** all provider credentials are stored in Postgres encrypted with
> AES-256-GCM using `SETTINGS_ENCRYPTION_KEY`. The ONLY env vars are
> `DATABASE_URL`, `SETTINGS_ENCRYPTION_KEY`, `JWT_SECRET`, `PUBLIC_URL`,
> `ADMIN_EMAIL`, `ADMIN_PASSWORD`. No provider secrets in env.
>
> **Database:** create the schema exactly as specified in the design doc
> (tables: `zoom_account`, `fathom_account`, `lms_account`, `youtube_channels`,
> `routing_rules`, `processed_recordings`, `run_logs`, `app_config`,
> `admin_users`). Run migrations on boot. Seed `app_config` defaults
> (cron `0 23 * * *`, timezone `Asia/Kolkata`, rolling_window_days `3`,
> zoom_delete_mode `delete`).
>
> **Scheduler:** node-cron reads `cron_expression` + timezone from `app_config`.
> Each run creates a `run_logs` row, processes Zoom then Fathom, updates counts.
> Also expose an authenticated `POST /api/run-now`.
>
> **Zoom puller:** using S2S creds from `zoom_account`, mint a token; call
> `GET /v2/users/me/recordings?from=&to=` over the rolling window. For each
> meeting, from `recording_files` select the file where
> `recording_type === "shared_screen_with_speaker_view"` AND `file_type === "MP4"`.
> If none, insert `processed_recordings` as `skipped_no_matching_view`. Dedupe on
> `(source='zoom', source_id=meeting UUID)`. Download the file by streaming its
> `download_url` (Authorization: Bearer token) to a temp file. After a verified
> YouTube upload, if `zoom_delete_mode != 'off'`, call
> `DELETE /v2/meetings/{doubleEncodedUUID}/recordings?action=<mode>` and set
> `source_deleted=true`.
>
> **Fathom puller:** using the API key from `fathom_account` (header
> `X-Api-Key`), call `GET https://api.fathom.ai/external/v1/meetings` over the
> rolling window (paginate; respect 60 req/min). For each meeting take
> `share_url`, dedupe on `(source='fathom', source_id=recording_id)`, and download
> via ffmpeg: `ffmpeg -hide_banner -loglevel error -http_persistent 0 -reconnect 1
> -reconnect_streamed 1 -reconnect_delay_max 5 -i "<share_url>/video.m3u8"
> -c copy -bsf:a aac_adtstoasc -movflags +faststart <temp>.mp4`. Fathom is
> read-only: never attempt to delete Fathom recordings.
>
> **Router:** match the meeting title against `routing_rules` (enabled,
> source-compatible), most-specific/highest-priority first, to get channel +
> playlist + privacy + keep_prefix. No match → `skipped_no_route` (do not upload,
> do not delete).
>
> **YouTube uploader:** for the routed channel, build an OAuth2 client from that
> row's `oauth_client_id`/`secret` + `refresh_token`. Resumable
> `videos.insert` (snippet.title from the meeting title, honoring keep_prefix;
> status.privacyStatus from the rule; selfDeclaredMadeForKids false), streaming
> from the temp file. Then ensure the playlist by exact title on that channel
> (list → find → create unlisted) and add the video. Store video id/url in
> `processed_recordings`, set `status='uploaded'`, `uploaded_at`.
>
> **LMS push:** after `status='uploaded'`, POST to the myappz.ai LMS ingest
> endpoint (`lms_account.base_url` + bearer `api_key`) with: the unlisted YouTube
> link, title, source, program/tag, the rule's `lms_course_id`/`lms_module_id`,
> `recorded_at`, duration, and `external_id = processed_recordings.id` for
> idempotency. Store `lms_lesson_id`/`lms_lesson_url`; set `lms_status='pushed'`
> on success or `'failed'` (retry next run). This step must NOT block the Zoom
> delete — YouTube is the durable copy the LMS only links to. Endpoint contract is
> in the companion "myappz.ai LMS Video Ingest API" spec.
>
> **State machine:** implement exactly the states in the design doc. Delete
> Zoom source ONLY after `status='uploaded'`. Wrap each recording in try/catch so
> one failure never halts the batch; on error set `status='error'` +
> `error_message` and continue. Process recordings sequentially. Delete temp
> files in a finally block.
>
> **Admin dashboard (JWT-protected):** pages for Login, Connections (Zoom S2S
> fields + test; Fathom API key + test; YouTube "Add channel" via a Google OAuth
> connect flow that stores the refresh token, with per-channel OAuth client
> fields; plus an LMS connection: base URL + API key + test), Routing (CRUD table
> of rules incl. per-rule lms_course_id/lms_module_id), Runs/Overview (last + next
> run, counts, and the searchable `processed_recordings` log table showing per
> video: **timestamp (uploaded_at), file name (title), source (zoom/fathom), the
> unlisted YouTube link, and the LMS lesson link**, plus status/source-deleted —
> this is the user's video organizer; capture the YouTube link automatically from
> the upload response), "Run now" button, Settings (cron/timezone, rolling window,
> zoom_delete_mode, email to/from). Implement the Google OAuth flow: redirect to Google with scopes
> `youtube.upload` + `youtube`, callback at `PUBLIC_URL/oauth/youtube/callback`
> stores the refresh token + resolved channel_id/handle.
>
> **Notifier:** after each run, email a summary to `email_to` via nodemailer
> (Gmail app password from `app_config`): posted (title → link per video),
> skipped, and errors; "No new recordings" when empty. Always send.
>
> **Reliability requirements:** idempotent (unique source+source_id);
> delete-after-verify; resumable uploads; ffmpeg reconnect flags; sequential
> processing; automatic token refresh (Zoom + YouTube); graceful handling of
> `quotaExceeded` (mark error, retry next run). Health route `GET /health`
> returns `{ ok: true }`.
>
> **Deploy:** include a Dockerfile `FROM node:18-slim` that installs ffmpeg via
> apt, plus a README covering Railway deploy, attaching Postgres, the six env
> vars, and first-login bootstrap. Provide the SQL migration file.
>
> Deliver a complete, runnable repo.

---

## 10. What you'll set up once (from the dashboard, after deploy)
- Zoom S2S app (Account/Client/Secret) with `cloud_recording:read` + `cloud_recording:write`.
- Fathom API key.
- One Google Cloud project per YouTube channel (YouTube Data API v3 enabled, OAuth client, consent screen Published), then "Add channel" → pick the channel at consent.
- Routing rules (tag → channel → playlist → LMS course/module).
- LMS (myappz.ai) base URL + API key — from the companion myappz.ai API spec.
- Schedule, delete mode, and the daily-log email.

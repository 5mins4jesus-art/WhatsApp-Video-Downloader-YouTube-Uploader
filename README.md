# WhatsApp Group Downloader → YouTube Uploader

Single-entrypoint pipeline that pulls media from selected WhatsApp groups via
`whatsapp-web.js`, uploads videos to YouTube, queues image-post batches for
the YouTube community tab, optionally builds one combined daily MP4 per chat,
and cleans up local media when you're done.

Everything is driven from one script: **`main_pipeline.mjs`**.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Provide credentials (see "Credentials" below)
#    - WhatsApp Web session is created on first run
#    - youtube_client_secret.json + youtube_oauth_token.json for YouTube

# 3. Run the pipeline
node main_pipeline.mjs --today --login-if-needed
```

With **no arguments** the pipeline runs the combine-day step only
(equivalent to `--combine-only`). Pass any flag (e.g. `--today`) to enable the
full download/upload flow.

---

## Prerequisites

- Node.js ≥ 24
- `ffmpeg` and `ffprobe` on PATH (used by the combine step)
- WhatsApp account on a phone able to scan the WhatsApp Web QR
- Google account with YouTube channel + Google Cloud OAuth Desktop client

Install everything Node-side:

```bash
npm install
```

Runtime dependencies (`package.json`):

| Package | Purpose |
|---|---|
| `whatsapp-web.js` | WhatsApp Web automation (history + media download) |
| `@whiskeysockets/baileys` | Legacy fallback for some history paths |
| `googleapis` | YouTube Data API v3 (auth + uploads) |
| `playwright` | Posting image batches to YouTube community tab |
| `mudslide` | Lightweight WhatsApp auth helper |
| `qrcode-terminal` | QR rendering for first-time WhatsApp login |
| `open` | Open OAuth consent URLs in the browser |
| `pino` | Logging used by Baileys |

System binaries the pipeline shells out to:

- `node` (executes the sub-scripts via `spawn`)
- `ffmpeg`, `ffprobe` (combine-day step)

---

## Credentials

Place these in the workspace root (all are gitignored):

| File | Required by | How to get it |
|---|---|---|
| `youtube_client_secret.json` | YouTube auth | Google Cloud Console → OAuth client → Desktop app |
| `youtube_oauth_token.json` | YouTube auth | Generated on first authenticated run |
| `.wwebjs_auth/` | WhatsApp Web | Created automatically after first QR scan |
| `.wwebjs_cache/` | WhatsApp Web | Cached WhatsApp Web build files |
| `.playwright-youtube-auth/` | Image posting | Created when you sign Playwright into YouTube |

Detailed YouTube OAuth setup: see `YOUTUBE_SETUP.md`.

---

## How `main_pipeline.mjs` is composed

`main_pipeline.mjs` is the only entrypoint you should normally run. It
spawns these sibling scripts as subprocesses and performs the combine +
cleanup steps inline:

| Step | Underlying script | When it runs |
|---|---|---|
| WhatsApp Web auth preflight | `check_whatsapp_wwebjs_auth.mjs` | Always (unless `--skip-auth`) |
| YouTube auth preflight | `check_youtube_auth.mjs` | Always except `--list-messages` |
| History listing | `list_historic_messages_wwebjs.mjs` | `--list-messages` |
| Video download + upload | `download_and_upload_wwebjs.mjs` | Default; skipped by `--images-only` |
| Image download + queue | `download_and_post_images_wwebjs.mjs` | Default; skipped by `--videos-only` |
| Image queue verify | `verify_youtube_image_posts.mjs` | After image pipeline |
| Next-batch summary | `process_image_post_queue.mjs --next` | After image pipeline |
| Playwright image poster | `post_youtube_images_playwright.mjs` | `--post-only` |
| Combine same-day media | *inlined in `main_pipeline.mjs`* | Always (skip with `--no-combine`) |
| Cleanup downloaded media | *inlined in `main_pipeline.mjs`* | `--cleanup-media` / `--cleanup-only` |

Other helper scripts in the repo that are **not** invoked automatically:

- `dedupe_youtube_videos.mjs` — find/remove duplicate uploads
- `rename_youtube_videos.mjs` — normalize titles & descriptions
- `mark_youtube_post_published.mjs` / `mark_youtube_post_verified.mjs`
- `reconcile_youtube_image_posts.mjs`
- `whatsapp_login.mjs` — standalone Baileys QR login
- `validate_history_sync.mjs`, `list_chats.mjs`, `watch_messages.mjs`

---

## Flag reference

Get the live list any time with:

```bash
node main_pipeline.mjs --help
```

### Selecting chats and date windows

| Flag | Description |
|---|---|
| `--chats "Name 1" "Name 2"` | Chat name filter (default: the 3 chats below) |
| `--all-history` | Walk full chat history |
| `--today` | Eastern-time today only |
| `--day-offset N` | Single Eastern-time day, N days ago |
| `--last-days N` | Today + previous N-1 Eastern-time days |
| `--limit N` | Page size for WhatsApp history walks (default 50) |
| `--message-id <id>` | Target one WhatsApp message exactly |

Use only one of `--today`, `--day-offset`, `--last-days`.

### Pipeline mode

| Flag | Description |
|---|---|
| `--list-messages` | Just list messages (requires `--chats`); skips YouTube auth |
| `--videos-only` | Run only the video pipeline |
| `--images-only` | Run only the image pipeline |
| `--download-only` | Download only, no upload/post |
| `--upload-only` | Upload from existing local downloads |
| `--force-upload` | Retry uploads even if logged as successful |
| `--post-only` | Post the next queued image batch via Playwright |
| `--include-retry` | When posting, include `retry-manual-publish` batches |
| `--verify-youtube` | Verify logged videos still exist on YouTube |
| `--reupload-missing-youtube` | Re-upload any missing logged videos |

### Auth

| Flag | Description |
|---|---|
| `--skip-auth` | Don't run the WhatsApp/YouTube auth preflight |
| `--login-if-needed` | Perform interactive login if the session/token is invalid |

### Combine step (runs by default; skip with `--no-combine`)

| Flag | Description |
|---|---|
| `--no-combine` | Skip the combine step |
| `--combine-only` | Run only the combine step (and `--cleanup-media` if set) |
| `--combine-date YYYY-MM-DD` | Single Eastern date override |
| `--combine-chat "Name"` | Restrict combine to one chat |
| `--combine-image-seconds N` | Per-image duration in the combined video (default 3) |
| `--combine-privacy V` | `public` (default) / `unlisted` / `private` |
| `--combine-skip-upload` | Build locally, don't upload |
| `--combine-dry-run` | Plan only |
| `--combine-force` | Rebuild groups already uploaded |
| `--combine-keep-temp` | Keep ffmpeg scratch dir |
| `--combine-keep-output` | Keep the combined `.mp4` after upload |
| `--combine-no-background-music` | Disable the generated ambient bed |

The combine step inherits `--today` / `--day-offset` / `--last-days` from the
outer pipeline if `--combine-date` is not supplied.

### Cleanup (save disk space)

| Flag | Description |
|---|---|
| `--cleanup-media` | After the pipeline, delete media files in `downloaded_videos/`, `downloaded_images/`, `combined_day_videos/` |
| `--cleanup-only` | Skip the pipeline and only run cleanup |
| `--cleanup-older-than N` | Only remove media files older than N days (default 0 = all) |
| `--cleanup-dry-run` | List candidates without deleting |

Cleanup preserves `.json`, `.log`, `.txt`, `.md` and anything without a known
media extension — logs and metadata are always kept.

---

## Common workflows

```bash
# Default behaviour: combine today's media only
node main_pipeline.mjs

# Full daily run: download + upload videos, download + queue images,
# combine same-day media, then delete the source files older than 7 days
node main_pipeline.mjs --today --login-if-needed --cleanup-media --cleanup-older-than 7

# Backfill last 3 days for one chat
node main_pipeline.mjs --last-days 3 --chats "JESUS CHRIST is the LORD" --login-if-needed

# Just list recent messages with sender names
node main_pipeline.mjs --list-messages --chats "JESUS CHRIST is the LORD" --limit 20

# Post the next queued image batch
node main_pipeline.mjs --images-only --post-only --login-if-needed

# Verify the YouTube side and re-upload anything missing
node main_pipeline.mjs --all-history --limit 1000 --reupload-missing-youtube

# Reclaim disk space without running the pipeline
node main_pipeline.mjs --cleanup-only --cleanup-older-than 14
```

npm script shortcuts (defined in `package.json`):

```bash
npm run main          # node main_pipeline.mjs
npm run combine:day   # node main_pipeline.mjs --combine-only
npm run auth:whatsapp # check_whatsapp_wwebjs_auth.mjs
npm run auth:youtube  # check_youtube_auth.mjs
npm run images:verify # verify_youtube_image_posts.mjs
npm run images:queue  # process_image_post_queue.mjs --next
npm run images:post   # post_youtube_images_playwright.mjs --next
```

---

## Image-post workflow (community tab)

YouTube has no public API for image community posts, so this repo:

1. Downloads images into `downloaded_images/` and tracks them in `image_metadata.json`.
2. Batches them (≤ 10 per post) into manifests under `youtube_post_queue/` and logs them in `youtube_post_log.json` as `pending-manual-publish`.
3. Uses Playwright (`post_youtube_images_playwright.mjs`) to drive the YouTube composer at `https://www.youtube.com/@<channel>/posts`.
4. After posting, the script (or `mark_youtube_post_verified.mjs`) writes the resolved post URL back into `youtube_post_log.json`.
5. `verify_youtube_image_posts.mjs --check-urls` is the source of truth for whether a post is still publicly available; `reconcile_youtube_image_posts.mjs --all-unavailable` moves dead posts back to `retry-manual-publish`.

Manual marking after browser publish:

```bash
node mark_youtube_post_verified.mjs <batchId> <postUrl>
```

---

## Combine same-day media

Combine images + videos for one Eastern-time day per chat into a single MP4
with an ambient background bed, then upload only that MP4:

```bash
node main_pipeline.mjs --combine-only
node main_pipeline.mjs --combine-only --combine-dry-run
node main_pipeline.mjs --combine-only --combine-date 2026-05-14 --combine-chat "JESUS CHRIST is the LORD"
```

Output is written to `combined_day_videos/` and recorded in
`combined_upload_log.json`. The combined `.mp4` is deleted after a successful
upload unless `--combine-keep-output` is set.

---

## Default target chats

If you don't pass `--chats`, the underlying scripts default to:

1. `JESUS CHRIST THE ONLY WAY`
2. `JESUS CHRIST is the LORD`
3. `5 Minutes for Jesus Christ`

---

## File layout

```
workspace/
├── main_pipeline.mjs              # ← the only entrypoint you usually run
├── check_whatsapp_wwebjs_auth.mjs # WhatsApp Web auth preflight
├── check_youtube_auth.mjs         # YouTube OAuth preflight
├── download_and_upload_wwebjs.mjs # Video download + upload
├── download_and_post_images_wwebjs.mjs # Image download + queue
├── list_historic_messages_wwebjs.mjs   # --list-messages backend
├── process_image_post_queue.mjs   # Queue inspection / marking
├── post_youtube_images_playwright.mjs  # Browser-driven image poster
├── verify_youtube_image_posts.mjs # Queue + URL verification
├── reconcile_youtube_image_posts.mjs   # Move unavailable posts → retry
├── mark_youtube_post_published.mjs
├── mark_youtube_post_verified.mjs
├── dedupe_youtube_videos.mjs      # (optional) duplicate cleanup
├── rename_youtube_videos.mjs      # (optional) title/description rewrite
├── package.json
├── YOUTUBE_SETUP.md
│
├── youtube_client_secret.json     # secret (gitignored)
├── youtube_oauth_token.json       # secret (gitignored)
├── .wwebjs_auth/                  # secret (gitignored)
├── .wwebjs_cache/                 # cache  (gitignored)
│
├── downloaded_videos/             # runtime (gitignored)
├── downloaded_images/             # runtime (gitignored)
├── combined_day_videos/           # runtime (gitignored)
├── watch_debug/                   # runtime (gitignored)
├── video_metadata.json            # runtime (gitignored)
├── image_metadata.json            # runtime (gitignored)
├── upload_log.json                # runtime (gitignored)
├── combined_upload_log.json       # runtime (gitignored)
├── youtube_post_log.json          # runtime (gitignored)
└── pipeline.log                   # runtime (gitignored)
```

---

## Troubleshooting

WhatsApp login
- First run needs a QR scan. If the QR doesn't render, ensure your terminal supports Unicode.
- Stale session: delete `.wwebjs_auth/` and re-run with `--login-if-needed`.

YouTube auth
- Token missing/expired → `node check_youtube_auth.mjs --login-if-needed`.
- `access_denied` from Google → add your Google account under *OAuth consent screen → Test users*.
- Rename / dedupe / reconcile flows require the broader `youtube.force-ssl` scope; the auth helper requests this set automatically when re-login is needed.

Combine step
- `ffmpeg`/`ffprobe` not found → install them and ensure they're on PATH.
- "No same-day media groups found" → no media exists for the selected date(s); widen the window with `--last-days`.

Cleanup
- Always preview first with `--cleanup-dry-run`.
- Only files with known media extensions in the three media dirs are removed; `.json`, `.log`, `.txt`, `.md` are always kept.

Unknown flag errors
- `main_pipeline.mjs` fails fast on unknown/mistyped flags and suggests the closest valid one (e.g. `--toda` → `--today`). This is intentional to prevent silent no-op runs.

# Tidepool

A self-hosted music streaming app for your own library: no ads, unlimited skips,
high-quality audio, offline downloads, synced lyrics and cross-device playback, served from
your own machine.

> **Status: Phase 3 (the player) is done.** Tidepool has a web app you can install on your
> phone's home screen, with a full player. Browsing is basic for now (recently added albums);
> library pages, playlists and search come next. See [`docs/PLAN.md`](docs/PLAN.md) for the plan.
>
> **On an iPhone?** Follow [`docs/IPHONE.md`](docs/IPHONE.md), a step-by-step guide.

## What works now

- Scans a folder of MP3 / FLAC / M4A (AAC, ALAC) / OGG (Vorbis, Opus) / WAV files.
- Reads tags (title, artists incl. "feat." credits, album, album artist, track/disc, year,
  genres, ReplayGain, embedded art). When tags are missing it falls back to the folder and
  file names (`Artist/Album (2019)/01 - Title.flac`, `CD2/` folders, and so on).
- Album art from embedded pictures or `cover.jpg` / `folder.png`, deduplicated and stored as
  64 / 300 / 640 px WebP thumbnails.
- Tracks are identified by content, so **moving or renaming files keeps their history**.
  Files that disappear are marked _missing_ (not deleted) until you purge them.
- Watches the folder and rescans incrementally when files change; manual rescan endpoint too.
- Instant, typo-tolerant search index (Meilisearch).
- **Streaming** with HTTP Range support, so seeking works (including on iPhone Safari).
  Quality tiers are Low / Normal / High (Opus 96 / 160 / 320) and Lossless. The server
  never transcodes up: a file already at or below the tier is sent as is. Devices that
  can't play Opus get AAC automatically. WAV becomes FLAC at Lossless. Transcodes stream
  immediately on first play, are cached on disk (LRU, size-capped), and are served from the
  cache after that.
- First-run admin setup, email + password login (argon2id), httpOnly cookie sessions.
- **Web app (PWA)**, mobile-first, installable on the home screen, dark and light themes:
  - Player bar on every screen and a full-screen Now Playing view. Play/pause, next/previous,
    seek, volume, true shuffle (nothing repeats until everything has played), repeat off / all / one.
  - Queue: _Play next_, _Add to queue_, drag to reorder (finger or keyboard), remove, clear,
    recently played. Queue, track and position come back after a reload, or on another device.
  - Lock screen / Control Center / headphone controls (Media Session).
  - Desktop: near-gapless playback (two audio decks), crossfade 0–12 s (skipped between tracks
    of the same album), 10-band equaliser with presets, volume levelling (ReplayGain). Loudness
    is measured automatically for files without ReplayGain tags.
  - iPhone: a single-player mode built to keep playing with the screen locked. Volume levelling
    and EQ are opt-in there, because iOS may pause sound processing when locked.
  - Picks the quality automatically when the connection is slow (from your chosen tier down).
  - Keyboard shortcuts (press `?`).

## Run it with Docker

Needs Docker with Compose v2. Works on x86-64 and arm64 (Raspberry Pi 5).

```bash
cp .env.example .env
# Edit .env:
#   POSTGRES_PASSWORD   any long random string
#   MEILI_MASTER_KEY    any long random string (≥16 chars), e.g. `openssl rand -hex 32`
#   MUSIC_HOST_DIR      your music folder, e.g. /home/me/Music or D:/Music on Windows
docker compose up -d --build
docker compose logs -f server      # watch the first scan
```

Then open **<http://localhost:3000>**. The first time, it asks you to create your account.
To use it on your iPhone, see [`docs/IPHONE.md`](docs/IPHONE.md).

The music folder is mounted **read-only**. Tidepool never modifies your files.

> **Windows:** if new files aren't picked up automatically, set `WATCH_POLLING=true` in `.env`
> (file-change events don't always cross into Docker on Windows or network shares).

## Develop without Docker

Prerequisites: Node 22.12+, pnpm 10 (`corepack enable`), ffmpeg on `PATH`, PostgreSQL 16 and
Meilisearch 1.16 running locally (or start just those two with
`docker compose up -d postgres meilisearch`).

```bash
pnpm install
cp .env.example .env            # point DATABASE_URL / MEILI_* / MUSIC_DIR at your setup
pnpm --filter @tidepool/server db:deploy
pnpm --filter @tidepool/server fixtures ./music   # optional: small generated test library
pnpm dev                        # API on http://localhost:3000 (serves apps/web/dist if built)
pnpm dev:web                    # web app with hot reload on http://localhost:5173 (proxies /api)
```

Checks:

```bash
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test        # needs Postgres + Meilisearch + ffmpeg; uses a separate `tidepool_test` DB
pnpm e2e         # browser tests (desktop + iPhone layouts); uses a `tidepool_e2e` DB
```

Browser tests need Chromium: `pnpm --filter @tidepool/web exec playwright install chromium`
(or point `PW_CHROMIUM_PATH` at an existing one).

The tests create the `tidepool_test` database's tables themselves, but the database must
exist and be owned by your DB user (`CREATE DATABASE tidepool_test OWNER tidepool;`). Override
with `TEST_DATABASE_URL`.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example) for the full,
commented list. The important ones:

| Variable                            | Default                 | Meaning                                                                                                  |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `MUSIC_HOST_DIR`                    | —                       | (Compose) host folder with your music, mounted read-only                                                 |
| `MUSIC_DIR` / `DATA_DIR`            | `/music` / `/data`      | Paths inside the server (art + caches live in `DATA_DIR`)                                                |
| `DATABASE_URL`                      | —                       | PostgreSQL connection string                                                                             |
| `MEILI_URL` / `MEILI_MASTER_KEY`    | —                       | Meilisearch                                                                                              |
| `PUBLIC_URL`                        | `http://localhost:3000` | Origin the app is served from (`https://…` forces Secure cookies; they're automatic behind HTTPS anyway) |
| `SCAN_ON_STARTUP` / `WATCH_LIBRARY` | `true` / `true`         | Full scan at boot / incremental rescans on change                                                        |
| `WATCH_POLLING`                     | `false`                 | Poll instead of inotify (network shares, Docker on Windows)                                              |
| `SCAN_CONCURRENCY`                  | `4`                     | Parallel file reads while scanning (use 2 on a Pi with a USB HDD)                                        |
| `MISSING_GRACE_DAYS`                | `0`                     | Auto-purge missing tracks after N days. `0` = never (purge manually)                                     |
| `TRANSCODE_CACHE_MAX_GB`            | `10`                    | Disk space for transcoded audio                                                                          |
| `TRANSCODE_CONCURRENCY`             | `2`                     | Simultaneous ffmpeg transcodes (2 for a Pi 5, 4 on a laptop)                                             |
| `LOUDNESS_ANALYSIS`                 | `true`                  | Measure loudness of untagged tracks in the background                                                    |
| `TIDEPOOL_LAN_IP`                   | —                       | Only for HTTPS on home Wi-Fi (`--profile lan-https`, docs/IPHONE.md)                                     |

## API quick reference

All under `/api/v1`. Writes made with the session cookie need an `X-Requested-With` header
(any value), which is a CSRF guard.

|                                                                                                     |                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                                                      | DB / search / ffmpeg status                                                                                                                                          |
| `GET,POST /auth/setup` · `POST /auth/login` · `POST /auth/logout` · `GET /me`                       | Account                                                                                                                                                              |
| `POST /library/scan` `{ "full": true }` · `GET /library/scan/:id` · `GET /library/scans`            | Scanning (admin)                                                                                                                                                     |
| `GET /library/stats` · `GET /library/missing` · `POST /library/missing/purge` `{ "trackIds"?: [] }` | Library maintenance                                                                                                                                                  |
| `GET /artists` · `/artists/:id` · `/albums` · `/albums/:id` · `/tracks` · `/tracks/:id` · `/genres` | Browse (cursor pagination: `?cursor=&limit=`)                                                                                                                        |
| `GET /art/:artworkId/:size`                                                                         | `size` = `64`, `300`, `640` or `orig` (WebP)                                                                                                                         |
| `GET /stream/:trackId?q=high&formats=mp3,mp4-aac,webm-opus,flac`                                    | Audio. `q` = `low`/`normal`/`high`/`lossless` (default: your setting); `formats` = what the device can play; `wait=1` = wait for the transcode and serve it seekable |
| `GET /stream/:trackId/original` · `GET /stream/:trackId/info` · `POST /stream/:trackId/prepare`     | Original file · what would be sent · pre-transcode (next track)                                                                                                      |
| `GET /me/settings` · `PATCH /me/settings`                                                           | Quality, crossfade, EQ, theme…                                                                                                                                       |
| `GET /me/player` · `PUT /me/player` · `POST /plays`                                                 | Saved queue/position (409 if another device saved meanwhile) · play history                                                                                          |

## Project layout

```
apps/server        Fastify API, scanner, transcoder, Prisma schema + migrations, tests
apps/web           React PWA: player engine (src/player), UI, Playwright tests (e2e/)
packages/shared    zod schemas and types shared by server and web app
deploy/            Caddy config for HTTPS on your home network
docs/PLAN.md       Architecture, schema notes, full route list, phase plan
docs/IPHONE.md     Getting Tidepool onto your iPhone's home screen
```

# Tidepool

A self-hosted music streaming app for your own library: no ads, unlimited skips,
high-quality audio, offline downloads, synced lyrics and cross-device playback, served from
your own machine.

> **Status: Phase 1 (library ingestion) is done.** There's no UI yet; the server scans your
> music folder and exposes a JSON API. See [`docs/PLAN.md`](docs/PLAN.md) for the full plan,
> schema and API.

## What works now

- Scans a folder of MP3 / FLAC / M4A (AAC, ALAC) / OGG (Vorbis, Opus) / WAV files.
- Reads tags (title, artists incl. "feat." credits, album, album artist, track/disc, year,
  genres, ReplayGain, embedded art). When tags are missing it falls back to the folder and
  file names (`Artist/Album (2019)/01 - Title.flac`, `CD2/` folders, and so on).
- Album art from embedded pictures or `cover.jpg` / `folder.png`, deduplicated and stored as
  64 / 300 / 640 px WebP thumbnails.
- Tracks are identified by content, so **moving or renaming files keeps their history**.
  Files that disappear are marked *missing* (not deleted) until you purge them.
- Watches the folder and rescans incrementally when files change; manual rescan endpoint too.
- Instant, typo-tolerant search index (Meilisearch).
- First-run admin setup, email + password login (argon2id), httpOnly cookie sessions.

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

Then create your account (first run only):

```bash
curl -c cookies.txt -H 'content-type: application/json' \
  -d '{"email":"you@example.com","displayName":"You","password":"a long password"}' \
  http://localhost:3000/api/v1/auth/setup
```

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
pnpm dev                        # server on http://localhost:3000 with reload
```

Checks:

```bash
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test        # needs Postgres + Meilisearch + ffmpeg; uses a separate `tidepool_test` DB
```

The tests create the `tidepool_test` database's tables themselves, but the database must
exist and be owned by your DB user (`CREATE DATABASE tidepool_test OWNER tidepool;`). Override
with `TEST_DATABASE_URL`.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example) for the full,
commented list. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `MUSIC_HOST_DIR` | — | (Compose) host folder with your music, mounted read-only |
| `MUSIC_DIR` / `DATA_DIR` | `/music` / `/data` | Paths inside the server (art + caches live in `DATA_DIR`) |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `MEILI_URL` / `MEILI_MASTER_KEY` | — | Meilisearch |
| `PUBLIC_URL` | `http://localhost:3000` | Origin the app is served from (`https://…` enables secure cookies) |
| `SCAN_ON_STARTUP` / `WATCH_LIBRARY` | `true` / `true` | Full scan at boot / incremental rescans on change |
| `WATCH_POLLING` | `false` | Poll instead of inotify (network shares, Docker on Windows) |
| `SCAN_CONCURRENCY` | `4` | Parallel file reads while scanning (use 2 on a Pi with a USB HDD) |
| `MISSING_GRACE_DAYS` | `0` | Auto-purge missing tracks after N days. `0` = never (purge manually) |

## API quick reference (Phase 1)

All under `/api/v1`. Writes made with the session cookie need an `X-Requested-With` header
(any value), which is a CSRF guard.

| | |
|---|---|
| `GET /healthz` | DB / search / ffmpeg status |
| `GET,POST /auth/setup` · `POST /auth/login` · `POST /auth/logout` · `GET /me` | Account |
| `POST /library/scan` `{ "full": true }` · `GET /library/scan/:id` · `GET /library/scans` | Scanning (admin) |
| `GET /library/stats` · `GET /library/missing` · `POST /library/missing/purge` `{ "trackIds"?: [] }` | Library maintenance |
| `GET /artists` · `/artists/:id` · `/albums` · `/albums/:id` · `/tracks` · `/tracks/:id` · `/genres` | Browse (cursor pagination: `?cursor=&limit=`) |
| `GET /art/:artworkId/:size` | `size` = `64`, `300`, `640` or `orig` (WebP) |

## Project layout

```
apps/server        Fastify API, scanner, Prisma schema + migrations, tests
packages/shared    zod schemas and types shared by server and (later) the web app
docs/PLAN.md       Architecture, schema notes, full route list, phase plan
```

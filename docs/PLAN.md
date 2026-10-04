# Tidepool — Phase 0 Plan

Self-hosted music streaming PWA for your own library. This document covers the
**folder structure**, **database schema (Prisma)**, **API route list**, and the
**WebSocket protocol**. Nothing is implemented yet; it's waiting on your review.

Status: **Approved** with changes; see [§7 Decisions](#7-decisions-from-review). Phases 1–3 are implemented.

---

## 1. Architecture at a glance

```
 iPhone app (Capacitor + native audio) ─┐
 Browser on laptop (React PWA)         ─┴─HTTPS──▶ Caddy ──▶ /api/*, /ws ──▶ server (Fastify)
       ▲  Service worker                          └──▶ /*  static web build       │
       │  (Workbox, offline cache)                                                │
                                                       ├─▶ PostgreSQL (Prisma)
                                                       ├─▶ Meilisearch
                                                       ├─▶ ffmpeg / ffprobe (child processes)
                                                       ├─▶ MUSIC_DIR (mounted **read-only**)
                                                       └─▶ DATA_DIR (art, transcode cache, uploads)
```

Key decisions:

- **Monorepo with pnpm workspaces**: `apps/server`, `apps/web`, `packages/shared`.
  `packages/shared` holds zod schemas + inferred types used by both sides
  (API request/response bodies, WS messages, smart-playlist rule trees), so the
  contract is checked at compile time and validated at runtime from one source.
- **The music folder is mounted read-only.** Tidepool never writes tags. Computed
  data (loudness, extracted art, transcodes) goes to `DATA_DIR` or Postgres.
- **One process for the API, scanner, watcher, and WebSocket hub.** Enough for a
  single machine/Pi; long jobs (scan, loudness analysis, recs rebuild) run on an
  in-process job queue with bounded concurrency (`p-queue`), so the API stays
  responsive. Can be split out later without schema changes.
- **ffmpeg is invoked as a child process** (no fluent-ffmpeg; it's unmaintained).
  Every invocation has a timeout, stderr is captured to pino, and failures map to
  typed errors (`TranscodeFailed`, `ProbeFailed`) so the client can fall back to
  the original file.
- **All images are WebP** at 64/300/640 px, generated with `sharp` (ships arm64 builds).
- **Mobile-first.** The primary client is an iPhone. Every screen is designed at phone width
  first; desktop is the secondary layout.
- **Multi-arch Docker images** (amd64 + arm64) from day one, so the Pi 5 move is a
  `docker compose pull`.

---

## 2. Folder structure

```
tidepool/
├── apps/
│   ├── server/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   ├── src/
│   │   │   ├── index.ts                 # boot: env → app → listen
│   │   │   ├── app.ts                   # buildApp(): registers plugins + modules (testable)
│   │   │   ├── env.ts                   # zod-parsed process.env, fails fast
│   │   │   ├── logger.ts                # pino config (pretty in dev, JSON in prod)
│   │   │   ├── plugins/
│   │   │   │   ├── prisma.ts
│   │   │   │   ├── meili.ts
│   │   │   │   ├── auth.ts              # session (cookie, or bearer from the iOS app) → request.user
│   │   │   │   ├── rate-limit.ts
│   │   │   │   ├── errors.ts            # error → JSON problem response
│   │   │   │   └── websocket.ts
│   │   │   ├── lib/
│   │   │   │   ├── safe-path.ts         # resolve-inside-root guard (path traversal)
│   │   │   │   ├── process.ts           # ffmpeg/ffprobe spawn wrapper: timeout, kill, stderr
│   │   │   │   ├── hash.ts              # quick hash (size + head/tail 64 KiB) + full SHA-256
│   │   │   │   ├── fractional-index.ts  # keys + rebalance routine (Phase 4)
│   │   │   │   └── normalize.ts         # name keys for artist/album dedupe
│   │   │   ├── jobs/
│   │   │   │   └── queue.ts             # in-process job queue
│   │   │   └── modules/                 # each: routes.ts, service.ts, schemas.ts, *.test.ts
│   │   │       ├── auth/
│   │   │       ├── users/               # profile, settings, user admin
│   │   │       ├── library/
│   │   │       │   ├── scanner.ts       # walk → diff → upsert
│   │   │       │   ├── metadata.ts      # music-metadata + fallbacks
│   │   │       │   ├── filename-parser.ts   # "Artist/Album/01 - Title.flac" etc.
│   │   │       │   ├── artwork.ts       # extract, dedupe, thumbnail
│   │   │       │   ├── loudness.ts      # ffmpeg ebur128
│   │   │       │   ├── watcher.ts       # chokidar, debounced
│   │   │       │   └── indexer.ts       # Meilisearch sync
│   │   │       ├── catalog/             # artists, albums, tracks, genres (read API)
│   │   │       ├── artwork/             # image serving
│   │   │       ├── stream/
│   │   │       │   ├── range.ts         # RFC 7233 Range parsing
│   │   │       │   ├── profiles.ts      # quality → ffmpeg args
│   │   │       │   ├── transcoder.ts    # transcode-to-cache, single-flight per (track, profile)
│   │   │       │   └── cache.ts         # LRU eviction under TRANSCODE_CACHE_MAX_GB
│   │   │       ├── playlists/
│   │   │       │   ├── smart-rules.ts   # rule tree → Prisma where
│   │   │       │   ├── m3u.ts           # import/export
│   │   │       │   └── mosaic.ts        # 2x2 cover
│   │   │       ├── likes/
│   │   │       ├── search/
│   │   │       ├── lyrics/
│   │   │       │   ├── lrc.ts           # LRC parser
│   │   │       │   └── lrclib.ts        # client + cache
│   │   │       ├── plays/
│   │   │       ├── player/              # PlaybackState, device registry, WS hub
│   │   │       ├── recs/                # mixes, radio, on-repeat, forgotten favourites
│   │   │       ├── stats/
│   │   │       └── health/
│   │   ├── test/
│   │   │   ├── fixtures/audio/          # tiny generated test files (ffmpeg sine, tagged)
│   │   │   └── helpers/                 # test DB (per-worker schema), app factory
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/                             # React app; also the Capacitor iOS app's web layer
│       ├── ios/                         # Capacitor iOS project (Phase 3, see §8)
│       ├── public/                      # icons, manifest assets
│       ├── src/
│       │   ├── main.tsx
│       │   ├── app/                     # router, providers, layout shell
│       │   ├── pages/                   # Home, Search, Library, Album, Artist, Playlist,
│       │   │                            # NowPlaying, Lyrics, Stats, Settings, Login
│       │   ├── components/              # design-system primitives (Button, Slider, Card, Skeleton…)
│       │   ├── features/
│       │   │   ├── player/
│       │   │   │   ├── engine/          # AudioEngine: 2 decks, Web Audio graph,
│       │   │   │   │                    # gapless/crossfade scheduler, EQ, ReplayGain
│       │   │   │   ├── queue.ts         # pure queue + true-shuffle logic (unit-tested)
│       │   │   │   ├── media-session.ts
│       │   │   │   ├── quality.ts       # throughput estimator → auto quality
│       │   │   │   └── components/      # PlayerBar, NowPlaying, QueuePanel, DevicePicker
│       │   │   ├── library/
│       │   │   ├── playlists/
│       │   │   ├── search/
│       │   │   ├── lyrics/
│       │   │   ├── offline/             # download manager, storage meter
│       │   │   └── connect/             # WS client, remote control
│       │   ├── stores/                  # Zustand: player, ui, settings
│       │   ├── api/                     # typed fetch client + TanStack Query hooks
│       │   ├── styles/                  # Tailwind config tokens (original palette)
│       │   └── sw.ts                    # Workbox service worker (injectManifest)
│       ├── e2e/                         # Playwright specs
│       ├── index.html
│       ├── vite.config.ts
│       ├── Dockerfile                   # build → static files (served by Caddy)
│       └── package.json
├── packages/
│   └── shared/
│       └── src/
│           ├── api/                     # zod schemas per resource
│           ├── ws.ts                    # WS message union
│           ├── smart-rules.ts
│           └── quality.ts               # quality enum ↔ codec/bitrate table
├── deploy/
│   ├── Caddyfile
│   └── docker-compose.prod.yml
├── scripts/
│   ├── seed.ts                          # royalty-free sample tracks
│   ├── create-user.ts                   # CLI user creation
│   └── backup.sh / restore.sh           # pg_dump + DATA_DIR tarball
├── docs/
│   └── PLAN.md                          # this file
├── docker-compose.yml                   # dev: postgres + meilisearch (+ optional app)
├── .env.example
├── pnpm-workspace.yaml
├── tsconfig.base.json                   # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├── eslint.config.js
├── .prettierrc
└── README.md
```

### `DATA_DIR` layout (a Docker volume)

```
data/
├── art/ab/abcdef…_64.webp | _300.webp | _640.webp | _orig.webp
├── transcode/<trackId>/<profile>.<ext>     # LRU-capped
├── uploads/playlist-covers/
└── tmp/                                    # in-progress transcodes, atomically renamed
```

### Environment variables (`.env.example`)

| Var | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://tidepool:…@postgres:5432/tidepool` | |
| `MEILI_URL` / `MEILI_MASTER_KEY` | `http://meili:7700` / — | |
| `MUSIC_HOST_DIR` | `D:/Music` | Host folder, mounted read-only at `/music` by compose |
| `MUSIC_DIR` | `/music` | Path as seen by the server |
| `DATA_DIR` | `/data` | |
| `PUBLIC_URL` | `https://tidepool.local` | Cookie domain, CORS origin |
| `TRANSCODE_CACHE_MAX_GB` | `10` | LRU eviction threshold (Phase 2) |
| `MISSING_GRACE_DAYS` | `0` | Auto-purge missing tracks after N days. `0` = never (manual purge) |
| `SCAN_CONCURRENCY` | `4` | Parallel file reads while scanning |
| `SCAN_ON_STARTUP` / `WATCH_LIBRARY` | `true` / `true` | Watcher can be disabled on NAS/SMB mounts where inotify doesn't fire |
| `LRCLIB_ENABLED` | `true` | Global kill switch for outbound lyric fetches (Phase 6) |
| `LOG_LEVEL` | `info` | |

---

## 3. Database schema (Prisma)

Design notes:

- **Multi-user ready.** Library tables (artists/albums/tracks) are global and shared;
  everything personal (playlists, likes, plays, settings, devices, player state)
  is keyed by `userId`.
- **File identity.** On scan each file is matched **by path first**, and skipped entirely if
  its size and mtime are unchanged. Otherwise it's matched **by content** using a *quick hash*:
  SHA-256 of the size plus the first and last 64 KiB, so at most 128 KiB is read per file.
  A file at a new path whose quick hash matches a track whose file is gone is a **move**: the
  `path` is updated and the `Track.id` is kept, so playlists, likes and history survive. A
  **full SHA-256** is computed only when the quick hash collides with a file that still exists.
  It decides between "exact duplicate" (skipped and reported in the scan's errors) and
  "different file" (new track), and is stored in `fullHash` for next time.
- **Missing files** get `missingSince` set instead of being deleted, so an unmounted drive
  doesn't wipe playlists. They're listed under Settings → Missing files with a manual
  **Purge** button (`GET /library/missing`, `POST /library/missing/purge`). Auto-purge after
  `MISSING_GRACE_DAYS` exists but is off by default.
- **Retagging** a file changes its quick hash but not its path, so the path match keeps the
  same track id. Moving *and* retagging between two scans is the one case that creates a new
  track; the old one then shows up as missing.
- **Liked Songs** is a `TrackLike` table rather than a playlist row: "is this liked?"
  checks for whole lists of tracks stay a single indexed lookup. The API presents it as
  a virtual playlist with id `liked`, so the UI treats it like any other playlist.
- **Playlist ordering** uses fractional-index string keys, so moving one track writes one row.
  Keys grow longer when you keep inserting at the same spot, so a **rebalance routine**
  rewrites a playlist's keys evenly in one transaction when any key passes a length
  threshold. It also runs from a nightly maintenance job.
- **Generated playlists** (Daily Mix 1–6, On Repeat, Forgotten Favourites) are real
  `Playlist` rows with `kind = GENERATED`, so they can be downloaded for offline use
  and appear in the library like any other playlist.
- **Plays** carry a client-generated `clientEventId`, so offline play history can be
  re-sent on reconnect without creating duplicates.

The schema lives in [`apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma),
the single source of truth. The copy that was here during review has been removed so the two
can't drift. Models: `User`, `Session`, `UserSettings`, `Artist`, `Album`, `Track`,
`TrackArtist`, `Genre`, `TrackGenre`, `Artwork`, `Lyrics`, `TranscodeCache`, `ScanRun`,
`Playlist`, `PlaylistTrack`, `TrackLike`, `PlayEvent`, `TrackCooccurrence`, `RecentSearch`,
`Device`, `PlaybackState`.

### Smart playlist rule format (stored in `Playlist.rules`, zod-validated)

```jsonc
{
  "match": "all",                         // "all" | "any"
  "rules": [
    { "field": "genre",  "op": "is",  "value": "Shoegaze" },
    { "field": "year",   "op": "gt",  "value": 2015 },
    { "field": "plays",  "op": "gte", "value": 5, "window": "30d" },   // "most played this month"
    { "match": "any", "rules": [ … ] }    // nesting allowed, max depth 3
  ],
  "sort":  { "by": "plays", "dir": "desc" },  // plays | lastPlayed | added | year | random | title
  "limit": 100
}
```

Fields: `title, artist, album, albumArtist, genre, year, durationMs, addedAt, lastPlayedAt,
plays (with optional window), liked, codec, lossless, bpm`. Ops: `is, isNot, contains,
notContains, gt, gte, lt, lte, between, inLast, notInLast`. The rule tree compiles to a Prisma
`where`, or to a SQL CTE for play-count rules, from an allow-list. Raw input never reaches SQL.

---

## 4. REST API (`/api/v1`)

Conventions: JSON bodies validated with zod (shared schemas); errors are
`{ error: { code, message, details? } }`; list endpoints use cursor pagination
(`?cursor=&limit=`, max 200); all routes require auth except `/auth/*` and `/healthz`.
Auth = `tp_session` httpOnly, `SameSite=Lax`, `Secure` cookie. State-changing cookie-authed
requests require the `X-Requested-With` header (simple CSRF defence alongside SameSite).
The Capacitor iOS app will send the same session token as `Authorization: Bearer` (see §8).

### Auth & account
| Method | Path | Purpose | Phase |
|---|---|---|---|
| GET | `/healthz` | Liveness + DB/Meili/ffmpeg checks | 1 |
| GET | `/auth/setup` | `{ needsSetup }`. True when no users exist | 1 |
| POST | `/auth/setup` | Create the first (admin) user; only works when there are 0 users | 1 |
| POST | `/auth/login` | Email + password → session cookie (rate-limited) | 1 |
| POST | `/auth/logout` | Revoke current session | 1 |
| GET | `/me` | Current user | 1 |
| PATCH | `/me` | Display name, email | 4 |
| POST | `/me/password` | Change password (revokes other sessions) | 4 |
| GET / PATCH | `/me/settings` | Quality, crossfade, EQ, normalisation, theme, offline cap | 2–3 |
| GET / POST | `/admin/users` | Admin: list / create users | 10 |

### Library management
| Method | Path | Purpose | Phase |
|---|---|---|---|
| POST | `/library/scan` | Start a scan `{ full?: boolean }` → `202 { scanId }`. 409 if one is already running | 1 |
| GET | `/library/scan/:id` | Progress + counts + errors | 1 |
| GET | `/library/scans` | Recent scan runs | 1 |
| GET | `/library/stats` | Track/album/artist counts, total size & duration | 1 |
| GET | `/library/missing` | Missing tracks, with what a purge would remove (playlist entries, like, plays) | 1 |
| POST | `/library/missing/purge` | Admin: `{ trackIds? }` purges some or all missing tracks | 1 |

### Catalog (read)
| Method | Path | Purpose | Phase |
|---|---|---|---|
| GET | `/artists` | `?sort=name|added&cursor` | 1 |
| GET | `/artists/:id` | Artist + albums + appears-on | 1 |
| GET | `/artists/:id/top-tracks` | By user's play count, falls back to album order | 4 |
| GET | `/albums` | `?sort=added|name|year|artist&genre=&cursor` | 1 |
| GET | `/albums/:id` | Album + ordered tracks (by disc, track) | 1 |
| GET | `/tracks` | `?ids=a,b,c` batch fetch, or paged list | 1 |
| GET | `/tracks/:id` | Full track incl. format + loudness | 1 |
| GET | `/genres` | Genres with counts | 4 |
| GET | `/genres/:id` | Albums + tracks in genre | 4 |
| GET | `/art/:artworkId/:size` | `size ∈ 64|300|640|orig`; immutable cache headers | 1 |

### Streaming
| Method | Path | Purpose | Phase |
|---|---|---|---|
| GET/HEAD | `/stream/:trackId` | `?q=low\|normal\|high\|lossless&codecs=opus,aac,flac,mp3`. Range-capable. Serves the **original** if it's at or below the requested tier *and* the client can decode its codec (never transcode up). Otherwise serves the cached transcode, transcoding first if needed. Lossless tier: FLAC/ALAC originals pass through; WAV is re-encoded to FLAC (lossless) and cached. AAC 256 is chosen automatically for clients that can't decode Opus | 2 |
| GET/HEAD | `/stream/:trackId/original` | Original bytes, Range-capable (used for Lossless + downloads) | 2 |
| GET | `/stream/:trackId/info` | Which file/profile `?q=` resolves to: codec, bitrate, size, `cached` | 2 |

| POST | `/stream/:trackId/prepare` | Start transcoding in the background (used for the next track in the queue). `202` if work started | 2 |

Transcode strategy (implemented in Phase 2):

- **Cached:** served from `DATA_DIR/transcode/<trackId>/<profile>.<ext>` with full Range support.
  Each entry records the source's quick hash, so a re-encoded or retagged file invalidates it.
- **Uncached, first request:** one ffmpeg run (the `tee` muxer) writes a seekable cache file
  *and* a live stream. The live bytes are also kept in memory while the job runs, so every
  listener starts from byte 0: a second device, or Safari's "probe 2 bytes, hang up,
  re-request" pattern. The live response is `200` without `Content-Length` or Range
  (like internet radio). Opus is WebM in both outputs; AAC is ADTS live and MP4 (`faststart`)
  when cached; FLAC is FLAC in both.
- **`?wait=1`** waits for the cache instead and then serves with Range. It's for seeking
  inside a track that's still transcoding, and a fallback if a browser won't play a live stream.
- **Single-flight + concurrency cap:** one job per (track, profile), with at most
  `TRANSCODE_CONCURRENCY` running at once.
- **Failures:** on an ffmpeg error the server sends the original if the client can play it
  (`X-Tidepool-Fallback: original`), else `502 TRANSCODE_FAILED`. The (track, profile) then
  backs off for 10 minutes.
- **Eviction:** least recently used first, once the cache exceeds `TRANSCODE_CACHE_MAX_GB`.
- **Speed (measured):** a 4-minute FLAC takes about 4–5.5 s to transcode fully on a 4-core
  x86 VM (FLAC→FLAC about 1 s); expect slower on a Pi 5. Live streaming hides this for the
  first play, and the player will call `/prepare` for the next track while the current one plays.

### Playlists & likes
| Method | Path | Purpose | Phase |
|---|---|---|---|
| GET | `/playlists` | User's playlists (incl. virtual `liked`, generated) | 4 |
| POST | `/playlists` | Create `{ name, description?, kind?, rules? }` | 4 |
| GET | `/playlists/:id` | Metadata + tracks (smart: resolved at read time) | 4 |
| PATCH | `/playlists/:id` | Rename / description / rules | 4 |
| DELETE | `/playlists/:id` | Delete | 4 |
| POST | `/playlists/:id/tracks` | Add `{ trackIds[], position?: "start"|"end"|{afterEntryId} }` | 4 |
| DELETE | `/playlists/:id/tracks` | Remove `{ entryIds[] }` | 4 |
| POST | `/playlists/:id/tracks/move` | `{ entryId, afterEntryId|null }` | 4 |
| PUT | `/playlists/:id/cover` | Multipart image upload (type sniffed, ≤ 10 MB, re-encoded to WebP) | 4 |
| DELETE | `/playlists/:id/cover` | Revert to auto mosaic | 4 |
| GET | `/playlists/:id/export.m3u8` | Download as M3U8 (paths relative to `MUSIC_DIR`) | 4 |
| POST | `/playlists/import` | Multipart M3U8 → `{ playlist, matched, unmatched[] }` (matches by path, then by artist + title) | 4 |
| POST | `/playlists/smart/preview` | Evaluate rules without saving | 4 |
| GET | `/me/likes` | Liked tracks, newest first | 4 |
| PUT / DELETE | `/me/likes/:trackId` | Like / unlike (idempotent) | 4 |
| GET | `/me/likes/contains` | `?ids=` → `boolean[]` | 4 |

### Home, history, search
| Method | Path | Purpose | Phase |
|---|---|---|---|
| GET | `/home` | Sections: recently played, recently added, mixes, on repeat, forgotten favourites | 4 / 9 |
| GET | `/me/recently-played` | Distinct recent contexts + tracks | 4 |
| GET | `/search` | `?q=&types=track,album,artist,playlist&limit=` → grouped hits + `topResult` | 5 |
| GET | `/me/recent-searches` | Last 20 | 5 |
| POST | `/me/recent-searches` | Record `{ query }` or `{ entityType, entityId }` | 5 |
| DELETE | `/me/recent-searches[/:id]` | Clear all / one | 5 |

### Lyrics
| Method | Path | Purpose | Phase |
|---|---|---|---|
| GET | `/tracks/:id/lyrics` | Resolution order: `.lrc` sidecar → embedded → cache → LRCLIB (if enabled). Returns `{ synced, lines: [{ timeMs, text }] }` or `{ synced: false, text }` | 6 |
| DELETE | `/tracks/:id/lyrics/cache` | Drop cached LRCLIB result / negative cache | 6 |

### Plays, recommendations, stats
| Method | Path | Purpose | Phase |
|---|---|---|---|
| POST | `/plays` | Batch `{ events: PlayEvent[] }`, idempotent by `clientEventId` (used for offline sync too) | 3 / 7 |
| GET | `/recs/mixes` | Daily Mix playlists (rebuilt nightly + on demand) | 9 |
| GET | `/recs/radio/:trackId` | `?limit=50` similar tracks: genre, artist, era, co-occurrence, (BPM/key/energy if present) | 9 |
| POST | `/recs/rebuild` | Force regenerate generated playlists | 9 |
| GET | `/stats/summary` | `?range=7d|30d|365d|all` minutes, top tracks/artists/genres | 9 |
| GET | `/stats/year/:year` | Year-in-review payload (top lists, per-month minutes, listening clock, streaks) | 9 |

### Player & devices (Connect-style)
Remote control between your own clients (phone ↔ laptop) goes over the WebSocket. REST is used
only for persistence and device management.

| Method | Path | Purpose | Phase |
|---|---|---|---|
| GET | `/me/player` | Full PlaybackState (queue, position, active device), to restore after a reload | 3 |
| PUT | `/me/player` | Persist state from the active device (queue, index, position). Uses `version` for optimistic concurrency | 3 |
| GET | `/me/devices` | Online + recently seen devices | 8 |
| PATCH / DELETE | `/me/devices/:id` | Rename / forget | 8 |

---

## 5. WebSocket protocol (`GET /api/v1/ws`)

Auth: session cookie (browser) or the session token as `Authorization: Bearer` (iOS app).
JSON messages are validated with the zod union in `packages/shared/src/ws.ts`.
Heartbeat: server pings every 15 s; a device that misses 2 pongs is marked offline,
and if it was the active device, playback state is frozen at its last reported
position (it doesn't advance).

**Client → server**
| type | payload | |
|---|---|---|
| `hello` | `{ deviceId, name, type, canPlay, protocolVersion }` | Must come first. Registers the device |
| `state` | `{ version, trackId, positionMs, isPlaying, volume, shuffle, repeat, queueRev }` | Active device only. On change, plus every 5 s while playing |
| `queue` | `{ version, queue }` | Active device only. On queue mutation |
| `command` | `{ id, action, args }` | Any device → server → active device. `action ∈ play, pause, next, previous, seek, volume, shuffle, repeat, enqueue, playContext` |
| `transfer` | `{ toDeviceId, play }` | |
| `ack` | `{ commandId, ok, error? }` | Active device confirms a command |

**Server → client**
| type | payload |
|---|---|
| `welcome` | `{ deviceId, state, devices }` |
| `devices` | `{ devices: [{ id, name, type, online, active }] }` |
| `state` | Full or delta PlaybackState (broadcast to all of the user's devices) |
| `command` | Forwarded command (only sent to the active device) |
| `activate` | `{ state }`: you're now the active device; load queue, seek to `positionMs`, play if requested |
| `deactivate` | Stop local output (another device took over) |
| `error` | `{ code, message, commandId? }` |

**Transfer flow:** A requests transfer to B → server asks the current active device to
flush its state (short timeout) → persists the state → sends `deactivate` to the old device
and `activate` to B with the queue and an interpolated position → broadcasts `devices` + `state`.

---

## 6. Phase checklist (test plan per phase)

| Phase | Unit (Vitest) | Integration / E2E |
|---|---|---|
| 1 Ingestion | filename parser, name normalisation, safe-path, quick hash, credits | Scan a generated fixture library (ffmpeg-made tagged/untagged files): counts, move detection, quick-hash collisions, duplicates, missing → soft delete → purge, watcher, Meili docs |
| 2 Streaming | Range parser, profile selection | 206/416 responses, seek mid-file, transcode cache hit, ffmpeg failure → 502 + fallback |
| 3 Player | queue + true-shuffle, crossfade scheduler math, ReplayGain → gain | Playwright: play/skip/seek, reload restores queue+position, keyboard shortcuts |
| 4 Library | smart-rule compiler, fractional index + rebalance, M3U parse/emit | CRUD + reorder (incl. 1000 inserts at one spot → rebalance), M3U round-trip |
| 5 Search | — | typo query ("radiohed") hits, filter chips |
| 6 Lyrics | LRC parser (multi-timestamp lines, offsets) | sidecar > embedded > LRCLIB (mocked), negative cache |
| 7 Offline | storage cap/eviction logic | Playwright offline mode: downloaded album plays, plays sync on reconnect |
| 8 Connect | WS message schemas, state interpolation | Two browser contexts: transfer, remote control |
| 9 Recs/stats | co-occurrence scoring, forgotten-favourites query | seeded play history → expected mixes |
| 10 Polish | — | axe accessibility checks, responsive screenshots, `docker compose up` smoke test on amd64 + arm64 (QEMU) |

Test DB: a separate `tidepool_test` database, migrated by Vitest's global setup. Test files run
serially and truncate tables. Meilisearch tests use a random per-app index prefix.

---

## 7. Decisions from review

1. **Quality tiers:** Low (Opus 96), Normal (Opus 160), High (Opus 320), Lossless. AAC is
   not a user-facing choice. It's picked automatically for clients that can't decode Opus,
   at 96 / 160 / 256 kbps to match Low / Normal / High, so Low still saves data on an iPhone.
2. **WAV under Lossless:** re-encoded to FLAC on the fly (lossless, about half the size) and cached.
3. **Accounts:** a first-run setup screen creates the admin. No public sign-up; the admin adds users.
4. **Never transcode up:** the original is served if it's at or below the target tier and the
   client can play its codec. Otherwise the server transcodes (to FLAC for lossless sources).
5. **Essentia:** optional sidecar container, deferred. Recommendations must work without it.
6. **No external devices (ESP32).** The `ApiToken` model, the `EXTERNAL` device type and the
   REST mirrors of player commands are removed. Cross-device control is only between Tidepool
   clients, over WebSocket.
7. **Mobile-first**, with the iPhone as the primary target.
8. **Hashing:** quick hash (size + first/last 64 KiB). A full hash is computed only on collision.
9. **Missing files:** a settings page lists them, with a manual purge. Auto-purge is off by default.
10. **Fractional sort keys** get a rebalance routine (Phase 4).

## 8. iPhone: PWA first

Decision after review: no Mac and no paid Apple developer account, so the iPhone client is the
**PWA added to the home screen**. Capacitor is the fallback if background playback proves unreliable.

What the PWA has to get right (Phase 3):

- Playback through a single `<audio>` element. Lock-screen and Control Center controls come
  from the **Media Session API** (metadata, artwork, play/pause/next/previous/seek).
- Playback must keep going when the screen locks or the user switches apps. iOS suspends
  JavaScript timers in the background, so advancing to the next track has to happen from
  the audio element's `ended` event, with the next track already prepared on the server.
- iOS ignores `HTMLMediaElement.volume` (the hardware buttons control volume), so ReplayGain
  normalisation and the EQ both need Web Audio (a GainNode and BiquadFilterNodes in front of
  the `<audio>` element). iOS may suspend that processing when the screen locks. This has to
  be tested on the device. The player will keep plain `<audio>` playback working regardless,
  so the worst case is that normalisation and EQ only apply while the app is in the
  foreground. Crossfade (optional) won't be attempted on iPhone.
- Home-screen apps keep their own cookies, separate from Safari, so you sign in once inside
  the installed app.
- **If background playback is unreliable** (music stops at lock or on track change), we
  revisit Capacitor with a native audio plugin. The earlier notes on that route: it needs a
  Mac or macOS CI, a free Apple ID re-signs every 7 days, the audio features would be
  rebuilt natively, and auth would use a Bearer token.

### Phase 3 as built

- **Engines.** `apps/web/src/player/engine/`: the *dual* engine (desktop) uses two `<audio>`
  decks through one Web Audio graph (ReplayGain gain → crossfade envelope → preamp → 10 biquad
  filters → master). Near-gapless means the next deck starts on a timer about 40 ms before the
  end. The *element* engine (iPhone/iPad) uses a single `<audio>`. The next URL is prepared ahead,
  and on `ended` it is set and `play()`ed synchronously. Web Audio there is opt-in per device.
- **Unlocking audio on iOS.** Taps that must fetch something before playing first play a tiny
  silent clip on the same element, inside the tap, so the later `play()` is allowed.
- **Queue.** Pure functions (`player/queue.ts`) over the same snapshot the server stores. The
  user queue (`upNext`) survives starting a new album, as in other players.
- **Saved state.** Saved to localStorage immediately and to `PUT /me/player` at most every few
  seconds, with `version` for conflicts. A restored session isn't loaded into the audio element
  until you press play, so nothing streams in the background.
- **Plays.** Real listening time is counted (seeking doesn't count). Kept in a localStorage outbox
  and sent to `POST /plays`, which is idempotent, so it already works for offline play in Phase 7.
- **Loudness.** Tracks without ReplayGain tags are measured in the background (ffmpeg `ebur128`,
  −18 LUFS reference). Album gain is the duration-weighted energy average of its tracks.
- **One address.** The server serves the built web app too (with a CSP), so the phone needs a
  single URL. HTTPS comes from Tailscale Serve, or from the optional Caddy profile on home Wi-Fi
  (`deploy/Caddyfile.lan`). See [IPHONE.md](IPHONE.md).
- **Not yet:** browsing beyond "recently added" (Phase 4), search (5), offline audio (7),
  device handoff (8).


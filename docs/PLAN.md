# Tidepool — Phase 0 Plan

Self-hosted music streaming PWA for your own library. This document covers the
**folder structure**, **database schema (Prisma)**, **API route list**, and the
**WebSocket protocol**. Nothing is implemented yet; it's waiting on your review.

Status: **DRAFT — awaiting approval.** See [Open questions](#7-open-questions) at the end.

---

## 1. Architecture at a glance

```
 Browser / PWA (React)  ──HTTPS──▶  Caddy  ──▶  /api/*, /ws  ──▶  server (Fastify)
       ▲  Service worker                 └──▶  /*  static web build
       │  (Workbox, offline cache)                     │
       │                                               ├─▶ PostgreSQL (Prisma)
 ESP32 / scripts ──REST + WS (bearer token)──▶ server  ├─▶ Meilisearch
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
│   │   │   │   ├── auth.ts              # cookie session + bearer token → request.user
│   │   │   │   ├── rate-limit.ts
│   │   │   │   ├── errors.ts            # error → JSON problem response
│   │   │   │   └── websocket.ts
│   │   │   ├── lib/
│   │   │   │   ├── safe-path.ts         # resolve-inside-root guard (path traversal)
│   │   │   │   ├── ffmpeg.ts            # spawn wrapper: timeout, kill, stderr capture
│   │   │   │   ├── hash.ts              # streaming SHA-256
│   │   │   │   ├── fractional-index.ts
│   │   │   │   └── normalize.ts         # name keys for artist/album dedupe
│   │   │   ├── jobs/
│   │   │   │   └── queue.ts             # in-process job queue
│   │   │   └── modules/                 # each: routes.ts, service.ts, schemas.ts, *.test.ts
│   │   │       ├── auth/
│   │   │       ├── users/               # profile, settings, api tokens
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
│   │   │       ├── player/              # PlaybackState, device registry, WS hub, REST controls
│   │   │       ├── recs/                # mixes, radio, on-repeat, forgotten favourites
│   │   │       ├── stats/
│   │   │       └── health/
│   │   ├── test/
│   │   │   ├── fixtures/audio/          # tiny generated test files (ffmpeg sine, tagged)
│   │   │   └── helpers/                 # test DB (per-worker schema), app factory
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/
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
│   ├── PLAN.md                          # this file
│   └── API.md                           # Phase 8: external device API
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
| `MUSIC_DIR` | `/music` | Container path; host path set in compose |
| `DATA_DIR` | `/data` | |
| `SESSION_SECRET` | — | Cookie signing |
| `PUBLIC_URL` | `https://tidepool.local` | Cookie domain, CORS origin |
| `TRANSCODE_CACHE_MAX_GB` | `10` | LRU eviction threshold |
| `SCAN_ON_STARTUP` / `WATCH_LIBRARY` | `true` / `true` | Watcher can be disabled on NAS/SMB mounts where inotify doesn't fire |
| `LRCLIB_ENABLED` | `true` | Global kill switch for outbound lyric fetches |
| `LOG_LEVEL` | `info` | |

---

## 3. Database schema (Prisma)

Design notes:

- **Multi-user ready.** Library tables (artists/albums/tracks) are global and shared;
  everything personal (playlists, likes, plays, settings, devices, player state)
  is keyed by `userId`.
- **File identity.** On scan each file is matched **by path first** (cheap: compare
  size + mtime, skip if unchanged), then **by `contentHash`** (catches moves/renames →
  update `path`, keep the same `Track.id` so playlists, likes, and history survive),
  and only otherwise inserted. Missing files get `missingSince` set instead of being
  deleted, so a temporarily unmounted drive doesn't wipe playlists; purged after a
  grace period (default 30 days).
- **Retagging** a file changes its hash but not its path, so the path match keeps the
  same track id. Moving *and* retagging at the same time between scans is the one
  case that creates a new track. Acceptable, and documented.
- **Liked Songs** is a `TrackLike` table rather than a playlist row: "is this liked?"
  checks for whole lists of tracks stay a single indexed lookup. The API presents it as
  a virtual playlist with id `liked`, so the UI treats it like any other playlist.
- **Playlist ordering** uses fractional-index string keys, so moving one track writes one row.
- **Generated playlists** (Daily Mix 1–6, On Repeat, Forgotten Favourites) are real
  `Playlist` rows with `kind = GENERATED`, so they can be downloaded for offline use
  and appear in the library like any other playlist.
- **Plays** carry a client-generated `clientEventId`, so offline play history can be
  re-sent on reconnect without creating duplicates.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ───────────────────────────── Users & auth ─────────────────────────────

enum UserRole {
  ADMIN
  USER
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique // stored lower-cased
  displayName  String
  passwordHash String // argon2id
  role         UserRole @default(USER)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  settings       UserSettings?
  sessions       Session[]
  apiTokens      ApiToken[]
  devices        Device[]
  playbackState  PlaybackState?
  playlists      Playlist[]
  likes          TrackLike[]
  plays          PlayEvent[]
  recentSearches RecentSearch[]
}

/// Server-side session; the cookie holds only a random token, DB stores its SHA-256.
model Session {
  id         String   @id @default(cuid())
  userId     String
  tokenHash  String   @unique
  userAgent  String?
  ip         String?
  createdAt  DateTime @default(now())
  lastUsedAt DateTime @default(now())
  expiresAt  DateTime

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
}

/// Long-lived bearer tokens for headless clients (ESP32 display etc.). Shown once, stored hashed.
model ApiToken {
  id         String    @id @default(cuid())
  userId     String
  name       String
  tokenHash  String    @unique
  scopes     String[] // e.g. ["player:read", "player:control"]
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  revokedAt  DateTime?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

enum StreamQuality {
  LOW // Opus 96
  NORMAL // Opus 160
  HIGH // Opus 320
  VERY_HIGH // AAC 256 (see open question)
  LOSSLESS // original passthrough
}

enum ThemePref {
  DARK
  LIGHT
  SYSTEM
}

model UserSettings {
  userId              String        @id
  streamQualityWifi   StreamQuality @default(HIGH)
  streamQualityCell   StreamQuality @default(NORMAL)
  downloadQuality     StreamQuality @default(HIGH)
  autoAdjustQuality   Boolean       @default(true)
  crossfadeSeconds    Int           @default(0) // 0–12, validated by zod
  gapless             Boolean       @default(true)
  normalization       Boolean       @default(true)
  normalizationMode   String        @default("track") // "track" | "album"
  eqEnabled           Boolean       @default(false)
  eqPreset            String?
  eqBands             Float[] // 10 gains in dB, -12..+12
  theme               ThemePref     @default(DARK)
  offlineStorageCapMb Int           @default(4096)
  fetchLyricsOnline   Boolean       @default(true) // LRCLIB opt-in/out
  updatedAt           DateTime      @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

// ───────────────────────────── Library ─────────────────────────────

model Artist {
  id        String   @id @default(cuid())
  name      String
  sortName  String
  nameKey   String   @unique // normalised (lower, trimmed, unicode-folded) for dedupe
  imageId   String? // falls back to an album cover in the API
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  image        Artwork?      @relation(fields: [imageId], references: [id], onDelete: SetNull)
  albums       Album[]       @relation("AlbumArtist")
  tracks       Track[]       @relation("TrackPrimaryArtist")
  trackCredits TrackArtist[]

  @@index([sortName])
}

model Album {
  id            String    @id @default(cuid())
  title         String
  sortTitle     String
  albumArtistId String
  albumKey      String    @unique // hash(normalised album artist + title) for dedupe
  year          Int?
  releaseDate   DateTime?
  isCompilation Boolean   @default(false)
  artworkId     String?
  trackCount    Int       @default(0) // denormalised, maintained by scanner
  discCount     Int       @default(1)
  durationMs    Int       @default(0)
  replayGainDb  Float? // album gain
  replayPeak    Float?
  createdAt     DateTime  @default(now()) // "recently added" sort key
  updatedAt     DateTime  @updatedAt

  albumArtist Artist   @relation("AlbumArtist", fields: [albumArtistId], references: [id])
  artwork     Artwork? @relation(fields: [artworkId], references: [id], onDelete: SetNull)
  tracks      Track[]

  @@index([albumArtistId])
  @@index([createdAt])
  @@index([year])
}

enum LoudnessSource {
  TAG // ReplayGain tags in file
  ANALYZED // ffmpeg ebur128
}

model Track {
  id            String @id @default(cuid())
  title         String
  sortTitle     String
  albumId       String
  artistId      String // primary artist (first credited)
  artistDisplay String // full credit string as tagged, e.g. "A feat. B"
  trackNumber   Int?
  discNumber    Int    @default(1)
  year          Int?
  durationMs    Int

  // File identity
  path         String    @unique // relative to MUSIC_DIR, POSIX separators
  contentHash  String    @unique // SHA-256 of file bytes → survives moves/renames
  fileSize     BigInt
  fileMtime    DateTime
  missingSince DateTime? // soft-delete: file vanished; purged after grace period

  // Format
  container  String // "flac" | "mp3" | "mp4" | "ogg" | "wav" ...
  codec      String // "flac" | "mp3" | "aac" | "alac" | "opus" | "vorbis" | "pcm_s16le"
  bitrate    Int? // bps
  sampleRate Int?
  bitDepth   Int?
  channels   Int?
  lossless   Boolean

  // Loudness / normalisation
  replayGainDb   Float?
  replayPeak     Float?
  loudnessLufs   Float?
  loudnessSource LoudnessSource?

  // Optional audio features (Phase 9, Essentia if feasible)
  bpm        Float?
  musicalKey String?
  energy     Float?

  artworkId     String? // embedded art; API falls back to album art
  hasLyricsFile Boolean  @default(false) // sidecar .lrc seen at scan
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  album          Album            @relation(fields: [albumId], references: [id])
  artist         Artist           @relation("TrackPrimaryArtist", fields: [artistId], references: [id])
  artwork        Artwork?         @relation(fields: [artworkId], references: [id], onDelete: SetNull)
  credits        TrackArtist[]
  genres         TrackGenre[]
  lyrics         Lyrics?
  transcodes     TranscodeCache[]
  playlistTracks PlaylistTrack[]
  likes          TrackLike[]
  plays          PlayEvent[]

  @@index([albumId, discNumber, trackNumber])
  @@index([artistId])
  @@index([createdAt])
  @@index([missingSince])
}

/// All credited artists of a track (supports "feat." and multi-artist tags).
model TrackArtist {
  trackId  String
  artistId String
  role     String @default("main") // "main" | "featured"
  position Int

  track  Track  @relation(fields: [trackId], references: [id], onDelete: Cascade)
  artist Artist @relation(fields: [artistId], references: [id], onDelete: Cascade)

  @@id([trackId, artistId])
  @@index([artistId])
}

model Genre {
  id     String       @id @default(cuid())
  name   String
  key    String       @unique // normalised
  tracks TrackGenre[]
}

model TrackGenre {
  trackId String
  genreId String

  track Track @relation(fields: [trackId], references: [id], onDelete: Cascade)
  genre Genre @relation(fields: [genreId], references: [id], onDelete: Cascade)

  @@id([trackId, genreId])
  @@index([genreId])
}

enum ArtworkSource {
  EMBEDDED
  FOLDER // cover.jpg / folder.png next to audio
  UPLOAD // user-uploaded playlist cover
  MOSAIC // generated 2x2 playlist cover
}

/// Deduplicated by image hash. Files live at $DATA_DIR/art/<hash[0..2]>/<hash>_{64,300,640}.webp
model Artwork {
  id            String        @id @default(cuid())
  hash          String        @unique
  source        ArtworkSource
  width         Int
  height        Int
  dominantColor String? // hex, for UI tinting
  createdAt     DateTime      @default(now())

  albums    Album[]
  tracks    Track[]
  artists   Artist[]
  playlists Playlist[]
}

enum LyricsSource {
  LRC_FILE
  EMBEDDED
  LRCLIB
  NOT_FOUND // negative cache so we don't hammer LRCLIB
}

model Lyrics {
  trackId   String       @id
  source    LyricsSource
  synced    Boolean
  content   String? // raw LRC or plain text
  language  String?
  fetchedAt DateTime     @default(now())

  track Track @relation(fields: [trackId], references: [id], onDelete: Cascade)
}

/// Transcoded files on disk ($DATA_DIR/transcode/...). Used for LRU eviction under a size cap.
model TranscodeCache {
  id             String   @id @default(cuid())
  trackId        String
  profile        String // "opus96" | "opus160" | "opus320" | "aac256" | "flac"
  path           String   @unique
  sizeBytes      BigInt
  createdAt      DateTime @default(now())
  lastAccessedAt DateTime @default(now())

  track Track @relation(fields: [trackId], references: [id], onDelete: Cascade)

  @@unique([trackId, profile])
  @@index([lastAccessedAt])
}

enum ScanStatus {
  RUNNING
  COMPLETED
  FAILED
  CANCELLED
}

model ScanRun {
  id         String     @id @default(cuid())
  trigger    String // "startup" | "manual" | "watcher"
  status     ScanStatus @default(RUNNING)
  startedAt  DateTime   @default(now())
  finishedAt DateTime?
  filesSeen  Int        @default(0)
  added      Int        @default(0)
  updated    Int        @default(0)
  moved      Int        @default(0)
  removed    Int        @default(0)
  errors     Json       @default("[]") // [{path, message}]
}

// ───────────────────────────── Playlists & likes ─────────────────────────────

enum PlaylistKind {
  NORMAL
  SMART // tracks resolved from `rules` at read time
  GENERATED // Daily Mix, On Repeat, etc. — rebuilt by the recs job
}

model Playlist {
  id            String       @id @default(cuid())
  ownerId       String
  name          String
  description   String?
  kind          PlaylistKind @default(NORMAL)
  rules         Json? // SMART: zod-validated rule tree; see PLAN.md
  generatorKey  String? // GENERATED: e.g. "daily-mix:2", "on-repeat"
  coverId       String? // UPLOAD or MOSAIC artwork
  coverIsCustom Boolean      @default(false)
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt
  generatedAt   DateTime?

  owner  User            @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  cover  Artwork?        @relation(fields: [coverId], references: [id], onDelete: SetNull)
  tracks PlaylistTrack[]

  @@unique([ownerId, generatorKey])
  @@index([ownerId])
}

/// One row per entry (duplicates allowed). Ordered by a fractional-index string so
/// a drag-reorder updates exactly one row.
model PlaylistTrack {
  id         String   @id @default(cuid())
  playlistId String
  trackId    String
  sortKey    String
  addedAt    DateTime @default(now())

  playlist Playlist @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  track    Track    @relation(fields: [trackId], references: [id], onDelete: Cascade)

  @@index([playlistId, sortKey])
  @@index([trackId])
}

/// "Liked Songs" — exposed by the API as a virtual playlist with id "liked".
model TrackLike {
  userId  String
  trackId String
  likedAt DateTime @default(now())

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  track Track @relation(fields: [trackId], references: [id], onDelete: Cascade)

  @@id([userId, trackId])
  @@index([userId, likedAt])
}

// ───────────────────────────── Listening history ─────────────────────────────

model PlayEvent {
  id                 String   @id @default(cuid())
  clientEventId      String   @unique // idempotency key: offline plays are re-sent safely
  userId             String
  trackId            String
  deviceId           String?
  listeningSessionId String // plays < 30 min apart share a session (co-listening signal)
  startedAt          DateTime
  msPlayed           Int
  percentPlayed      Float // 0..1
  skipped            Boolean
  contextType        String? // "album" | "playlist" | "artist" | "radio" | "search" | "queue"
  contextId          String?
  playedOffline      Boolean  @default(false)
  receivedAt         DateTime @default(now())

  user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  track  Track   @relation(fields: [trackId], references: [id], onDelete: Cascade)
  device Device? @relation(fields: [deviceId], references: [id], onDelete: SetNull)

  @@index([userId, startedAt])
  @@index([userId, trackId, startedAt])
  @@index([listeningSessionId])
}

/// Materialised by a nightly job from PlayEvent sessions. trackAId < trackBId.
model TrackCooccurrence {
  userId    String
  trackAId  String
  trackBId  String
  score     Float
  updatedAt DateTime @updatedAt

  @@id([userId, trackAId, trackBId])
  @@index([userId, trackAId, score])
  @@index([userId, trackBId, score])
}

model RecentSearch {
  id         String   @id @default(cuid())
  userId     String
  query      String?
  entityType String? // set when the user clicked a result: "track" | "album" | "artist" | "playlist"
  entityId   String?
  createdAt  DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
}

// ───────────────────────────── Devices & playback ─────────────────────────────

enum DeviceType {
  DESKTOP
  PHONE
  TABLET
  EXTERNAL // ESP32 etc. — control/display only, cannot be a playback target
}

model Device {
  id         String     @id // client-generated UUID, persisted in localStorage
  userId     String
  name       String
  type       DeviceType
  canPlay    Boolean    @default(true)
  userAgent  String?
  lastSeenAt DateTime   @default(now())
  createdAt  DateTime   @default(now())

  user  User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  plays PlayEvent[]

  @@index([userId])
}

enum RepeatMode {
  OFF
  ALL
  ONE
}

/// Authoritative per-user player state (source for reload-restore and device transfer).
/// Live position is interpolated: positionMs + (now - positionUpdatedAt) when isPlaying.
model PlaybackState {
  userId            String     @id
  activeDeviceId    String?
  currentTrackId    String?
  positionMs        Int        @default(0)
  positionUpdatedAt DateTime   @default(now())
  isPlaying         Boolean    @default(false)
  volume            Float      @default(1) // 0..1
  shuffle           Boolean    @default(false)
  repeat            RepeatMode @default(OFF)
  queue             Json       @default("{}") // {context, items[], userQueue[], shuffleOrder[], index}
  history           Json       @default("[]") // last ~100 played track ids
  version           Int        @default(0) // optimistic concurrency for WS updates
  updatedAt         DateTime   @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

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
Auth = `tp_session` httpOnly, `SameSite=Lax`, `Secure` cookie, **or** `Authorization: Bearer <api token>`
(scoped; for headless devices only). State-changing cookie-authed requests require the
`X-Requested-With` header (simple CSRF defence alongside SameSite).

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
| GET / POST | `/me/api-tokens` | List / create (token returned once) | 8 |
| DELETE | `/me/api-tokens/:id` | Revoke | 8 |
| GET / POST | `/admin/users` | Admin: list / create users | 10 |

### Library management
| Method | Path | Purpose | Phase |
|---|---|---|---|
| POST | `/library/scan` | Start a scan `{ full?: boolean }` → `202 { scanId }`. 409 if one is already running | 1 |
| GET | `/library/scan/:id` | Progress + counts + errors | 1 |
| GET | `/library/scans` | Recent scan runs | 1 |
| GET | `/library/stats` | Track/album/artist counts, total size & duration | 1 |

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
| GET/HEAD | `/stream/:trackId` | `?q=low|normal|high|very_high|lossless`. Range-capable. Serves the original when it's already at or below the requested quality (no pointless upscaling); otherwise serves the cached transcode, transcoding first if needed | 2 |
| GET/HEAD | `/stream/:trackId/original` | Original bytes, Range-capable (used for Lossless + downloads) | 2 |
| GET | `/stream/:trackId/info` | Which file/profile `?q=` resolves to: codec, bitrate, size, `cached` | 2 |

Transcode strategy: first request for an uncached (track, profile) transcodes the whole
file to `tmp/`, then renames atomically into the cache (single-flight: concurrent requests
wait on the same job). While that runs, the response is a chunked progressive stream
**without** Range, so playback starts immediately. After caching, full Range support.
A typical 4-minute track transcodes in about 1–2 s on a laptop and ~4–6 s on a Pi 5. The
client also prefetches the next track's transcode via `HEAD`.

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
REST mirrors the WS commands, so simple HTTP clients (ESP32) can work without WS.

| Method | Path | Purpose | Phase |
|---|---|---|---|
| GET | `/me/player` | Full PlaybackState (queue, position, active device) | 3 / 8 |
| PUT | `/me/player` | Persist state from the active device (queue, index, position). Uses `version` for optimistic concurrency | 3 |
| GET | `/me/player/now-playing` | Compact: track, artist, album, art URL (64/300), `positionMs`, `durationMs`, `isPlaying`, `volume`, device. Built for small displays | 8 |
| POST | `/me/player/play` · `/pause` · `/next` · `/previous` | Control the active device | 8 |
| POST | `/me/player/seek` | `{ positionMs }` | 8 |
| POST | `/me/player/volume` | `{ volume: 0..1 }` | 8 |
| POST | `/me/player/shuffle` · `/repeat` | `{ on }` · `{ mode }` | 8 |
| POST | `/me/player/queue` | `{ trackIds[], mode: "next"|"last" }` | 8 |
| POST | `/me/player/transfer` | `{ deviceId, play?: boolean }` | 8 |
| GET | `/me/devices` | Online + recently seen devices | 8 |
| PATCH / DELETE | `/me/devices/:id` | Rename / forget | 8 |

---

## 5. WebSocket protocol (`GET /api/v1/ws`)

Auth: session cookie, or `?token=` / `Authorization: Bearer` for API tokens.
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
| 1 Ingestion | filename parser, name normalisation, safe-path, hash, art dedupe | Scan a generated fixture library (ffmpeg-made tagged/untagged files): counts, move detection, missing → soft delete, Meili docs |
| 2 Streaming | Range parser, profile selection | 206/416 responses, seek mid-file, transcode cache hit, ffmpeg failure → 502 + fallback |
| 3 Player | queue + true-shuffle, crossfade scheduler math, ReplayGain → gain | Playwright: play/skip/seek, reload restores queue+position, keyboard shortcuts |
| 4 Library | smart-rule compiler, fractional index, M3U parse/emit | CRUD + reorder, M3U round-trip |
| 5 Search | — | typo query ("radiohed") hits, filter chips |
| 6 Lyrics | LRC parser (multi-timestamp lines, offsets) | sidecar > embedded > LRCLIB (mocked), negative cache |
| 7 Offline | storage cap/eviction logic | Playwright offline mode: downloaded album plays, plays sync on reconnect |
| 8 Connect | WS message schemas, state interpolation | Two browser contexts: transfer, remote control; REST controls via token |
| 9 Recs/stats | co-occurrence scoring, forgotten-favourites query | seeded play history → expected mixes |
| 10 Polish | — | axe accessibility checks, responsive screenshots, `docker compose up` smoke test on amd64 + arm64 (QEMU) |

Test DB: Postgres in Docker; each Vitest worker gets its own schema. Meilisearch tests use a
per-run index prefix.

---

## 7. Open questions

1. **Very High quality.** Your list maps Very High → AAC 256, which is a step *down* from
   High = Opus 320. Proposal: Low = Opus 96, Normal = Opus 160, High = Opus 320,
   Very High = **AAC 256 used only as the compatibility profile for old iOS Safari** (picked
   automatically when the browser can't decode Opus), and Lossless = original FLAC/ALAC/WAV
   passthrough. In other words, four quality levels plus automatic codec selection. Or did you
   want AAC 256 as an explicit user choice?
2. **Lossless for non-FLAC sources.** WAV is about twice the size of FLAC. Should Lossless
   transcode WAV → FLAC on the fly (same quality, half the bandwidth), or pass every lossless
   file through untouched?
3. **User creation.** Proposal: first-run setup screen creates the admin; after that,
   **no public sign-up**. The admin adds users from settings or with `scripts/create-user.ts`.
   OK?
4. **Lossy sources at High/Lossless.** For an MP3 at 320 kbps, "High" and "Lossless" should
   both serve the original MP3. Transcoding lossy → lossy only lowers quality. Agree?
5. **Essentia audio features (Phase 9).** The ARM64 build is painful. Proposal: make it an
   optional sidecar container, with recommendations working fully without it. OK to defer?

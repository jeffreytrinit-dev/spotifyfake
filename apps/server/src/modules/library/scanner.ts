import fs from 'node:fs/promises';
import path from 'node:path';
import PQueue from 'p-queue';
import type { FastifyBaseLogger } from 'fastify';
import type { ScanError } from '@tidepool/shared';
import type { Db } from '../../db.js';
import { hashFile, quickHashFile } from '../../lib/hash.js';
import { albumKey, nameKey, sortName } from '../../lib/normalize.js';
import { isInside, toLibraryPath } from '../../lib/safe-path.js';
import type { ArtworkStore } from './artwork.js';
import { isAudioFile, readTrackMetadata, type ParsedTrack } from './metadata.js';

export interface ScanCounters {
  filesSeen: number;
  added: number;
  updated: number;
  moved: number;
  removed: number;
  errors: ScanError[];
}

/** Ids whose search documents must be refreshed after the scan. */
export interface ScanTouched {
  tracks: Set<string>;
  albums: Set<string>;
  artists: Set<string>;
}

export interface ScannerDeps {
  db: Db;
  artwork: ArtworkStore;
  log: FastifyBaseLogger;
  musicDir: string;
  concurrency: number;
  missingGraceDays: number;
}

const MAX_RECORDED_ERRORS = 500;

interface KnownTrack {
  id: string;
  path: string;
  fileSize: bigint;
  fileMtime: Date;
  missingSince: Date | null;
  albumId: string;
}

interface TrackFile {
  path: string;
  quickHash: string;
  fullHash: string | null;
  fileSize: bigint;
  fileMtime: Date;
}

type ContentMatch =
  { kind: 'new' } | { kind: 'duplicate'; of: string } | { kind: 'moved'; track: KnownTrack };

const knownTrackSelect = {
  id: true,
  path: true,
  fileSize: true,
  fileMtime: true,
  missingSince: true,
  albumId: true,
} as const;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * One scan pass. Instances are single-use: create, call `full()` or `paths()`, read counters.
 * File reads/hashing run in parallel; DB writes go through a single-slot queue so artist /
 * album upserts never race each other.
 */
export class Scanner {
  readonly counters: ScanCounters = {
    filesSeen: 0,
    added: 0,
    updated: 0,
    moved: 0,
    removed: 0,
    errors: [],
  };
  readonly touched: ScanTouched = { tracks: new Set(), albums: new Set(), artists: new Set() };
  private readonly work: PQueue;
  private readonly writes = new PQueue({ concurrency: 1 });
  private readonly seenTrackIds = new Set<string>();
  private readonly startedAt = new Date();

  constructor(
    private readonly deps: ScannerDeps,
    private readonly opts: { forceReread: boolean },
  ) {
    this.work = new PQueue({ concurrency: deps.concurrency });
  }

  private recordError(relPath: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.deps.log.warn({ path: relPath, err: message }, 'scan: file skipped');
    if (this.counters.errors.length < MAX_RECORDED_ERRORS)
      this.counters.errors.push({ path: relPath, message });
  }

  // ───────────── entry points ─────────────

  /** Walk the whole library, then soft-delete anything not seen and purge expired tracks. */
  async full(): Promise<void> {
    const known = new Map<string, KnownTrack>();
    for (const t of await this.deps.db.track.findMany({ select: knownTrackSelect }))
      known.set(t.path, t);

    for await (const abs of this.walk(this.deps.musicDir)) {
      this.counters.filesSeen++;
      await this.work.onSizeLessThan(this.deps.concurrency * 4);
      void this.work.add(() => this.processFile(abs, known));
    }
    await this.work.onIdle();
    await this.writes.onIdle();

    const unseen = [...known.values()].filter(
      (t) => !this.seenTrackIds.has(t.id) && t.missingSince === null,
    );
    await this.markMissing(unseen);
    await this.finish();
  }

  /**
   * Incremental pass for the watcher: `changed` are files or directories that appeared or
   * changed, `removed` are paths that disappeared. Changes go first so a move (unlink + add)
   * is matched by hash before the old path is marked missing.
   */
  async paths(changed: string[], removed: string[]): Promise<void> {
    for (const abs of changed) {
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) continue;
      const files = stat.isDirectory()
        ? this.walk(abs)
        : (async function* () {
            yield abs;
          })();
      for await (const file of files) {
        if (!isAudioFile(file)) continue;
        this.counters.filesSeen++;
        void this.work.add(() => this.processFile(file, null));
      }
    }
    await this.work.onIdle();
    await this.writes.onIdle();

    const gone: KnownTrack[] = [];
    for (const abs of removed) {
      if (await exists(abs)) continue; // re-created since the event
      const rel = toLibraryPath(this.deps.musicDir, abs);
      const candidates = await this.deps.db.track.findMany({
        where: { missingSince: null, OR: [{ path: rel }, { path: { startsWith: `${rel}/` } }] },
        select: knownTrackSelect,
      });
      for (const t of candidates) {
        if (!(await exists(path.join(this.deps.musicDir, t.path)))) gone.push(t);
      }
    }
    await this.markMissing(gone);
    await this.finish();
  }

  /**
   * Hard-delete missing tracks (all, or the given ids; ids of present tracks are ignored).
   * Their playlist entries, likes and play history go with them via cascades.
   */
  async purgeMissing(ids: string[] | null): Promise<void> {
    const rows = await this.deps.db.track.findMany({
      where: { missingSince: { not: null }, ...(ids ? { id: { in: ids } } : {}) },
      select: { id: true, albumId: true },
    });
    if (rows.length) {
      await this.touchCreditedArtists(rows.map((r) => r.id));
      await this.deps.db.track.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      for (const r of rows) this.markTouched(r.id, r.albumId);
    }
    this.counters.removed = rows.length;
    await this.finish();
  }

  // ───────────── walking ─────────────

  private async *walk(dir: string): AsyncGenerator<string> {
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch (err) {
      this.recordError(toLibraryPath(this.deps.musicDir, dir) || '.', err);
      return;
    }
    for await (const entry of handle) {
      if (entry.name.startsWith('.')) continue; // .DS_Store, .stfolder, dot-dirs
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(abs);
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        yield abs;
      } else if (entry.isSymbolicLink() && isAudioFile(entry.name)) {
        // Symlinked files are followed only if they stay inside the library (dir links are
        // never followed, which also rules out cycles).
        const real = await fs.realpath(abs).catch(() => null);
        const root = await fs.realpath(this.deps.musicDir);
        if (real && isInside(root, real)) yield abs;
      }
    }
  }

  // ───────────── per file ─────────────

  private async processFile(abs: string, known: Map<string, KnownTrack> | null): Promise<void> {
    const rel = toLibraryPath(this.deps.musicDir, abs);
    try {
      const stat = await fs.stat(abs);
      const existing =
        known?.get(rel) ??
        (known
          ? null
          : await this.deps.db.track.findUnique({
              where: { path: rel },
              select: knownTrackSelect,
            }));

      const unchanged =
        existing &&
        existing.fileSize === BigInt(stat.size) &&
        existing.fileMtime.getTime() === Math.trunc(stat.mtimeMs);
      if (existing && unchanged && !this.opts.forceReread) {
        this.seenTrackIds.add(existing.id);
        if (existing.missingSince) {
          await this.writes.add(() =>
            this.deps.db.track.update({ where: { id: existing.id }, data: { missingSince: null } }),
          );
          this.markTouched(existing.id, existing.albumId);
        }
        return;
      }

      const [quickHash, parsed] = await Promise.all([
        quickHashFile(abs, stat.size),
        readTrackMetadata(abs, rel),
      ]);
      const art = await this.resolveArtwork(abs, parsed);
      const file: TrackFile = {
        path: rel,
        quickHash,
        fullHash: null,
        fileSize: BigInt(stat.size),
        fileMtime: new Date(Math.trunc(stat.mtimeMs)),
      };

      if (existing) {
        // Same path, new bytes (retagged/re-encoded): update in place, keeping the id.
        await this.writes.add(() => this.writeTrack(existing.id, parsed, file, art));
        this.seenTrackIds.add(existing.id);
        this.counters.updated++;
        return;
      }

      // Identity matching runs on the write queue so two identical new files processed in
      // parallel can't both be inserted.
      await this.writes.add(async () => {
        const match = await this.matchByContent(abs, rel, file);
        if (match.kind === 'duplicate') {
          throw new Error(`duplicate of "${match.of}" (identical content); skipped`);
        }
        if (match.kind === 'moved') {
          // Moved/renamed: keep the id so playlists, likes and history follow the file.
          await this.writeTrack(match.track.id, parsed, file, art);
          this.seenTrackIds.add(match.track.id);
          this.counters.moved++;
          return;
        }
        this.seenTrackIds.add(await this.writeTrack(null, parsed, file, art));
        this.counters.added++;
      });
    } catch (err) {
      this.recordError(rel, err);
    }
  }

  /**
   * Decide whether a file at a path we've never seen is new, a moved track, or a duplicate.
   * Tracks sharing its quick hash are split into those whose file still exists (possible
   * duplicates, confirmed with a full hash) and those whose file is gone (move sources).
   * Full hashes are only computed in that collision case and are stored for next time.
   */
  private async matchByContent(abs: string, rel: string, file: TrackFile): Promise<ContentMatch> {
    const db = this.deps.db;
    const candidates = await db.track.findMany({
      where: { quickHash: file.quickHash, path: { not: rel } },
      select: { ...knownTrackSelect, fullHash: true },
    });
    if (!candidates.length) return { kind: 'new' };

    const present: typeof candidates = [];
    const gone: typeof candidates = [];
    for (const c of candidates) {
      ((await exists(path.join(this.deps.musicDir, c.path))) ? present : gone).push(c);
    }

    if (present.length) {
      file.fullHash = await hashFile(abs);
      for (const c of present) {
        let full = c.fullHash;
        if (!full) {
          full = await hashFile(path.join(this.deps.musicDir, c.path));
          await db.track.update({ where: { id: c.id }, data: { fullHash: full } });
        }
        if (full === file.fullHash) return { kind: 'duplicate', of: c.path };
      }
    }

    if (gone.length) {
      // Several vanished files with the same quick hash: prefer one whose stored full hash
      // matches (only known if they collided before), else the most recently seen.
      const confirmed = file.fullHash ? gone.find((g) => g.fullHash === file.fullHash) : undefined;
      const pick =
        confirmed ?? gone.sort((a, b) => b.fileMtime.getTime() - a.fileMtime.getTime())[0]!;
      return { kind: 'moved', track: pick };
    }
    return { kind: 'new' };
  }

  private async resolveArtwork(
    abs: string,
    parsed: ParsedTrack,
  ): Promise<{ track: string | null; folder: string | null }> {
    const [track, folder] = await Promise.all([
      parsed.picture
        ? this.deps.artwork.ingest(parsed.picture.data, 'EMBEDDED')
        : Promise.resolve(null),
      this.deps.artwork.folderArtwork(path.dirname(abs)),
    ]);
    return { track, folder };
  }

  private markTouched(trackId: string, albumId: string): void {
    this.touched.tracks.add(trackId);
    this.touched.albums.add(albumId);
  }

  private async upsertArtist(name: string): Promise<string> {
    const key = nameKey(name);
    const artist = await this.deps.db.artist.upsert({
      where: { nameKey: key },
      create: { name, sortName: sortName(name), nameKey: key },
      update: {},
      select: { id: true },
    });
    this.touched.artists.add(artist.id);
    return artist.id;
  }

  private async upsertGenre(name: string): Promise<string> {
    const key = nameKey(name);
    const genre = await this.deps.db.genre.upsert({
      where: { key },
      create: { name, key },
      update: {},
      select: { id: true },
    });
    return genre.id;
  }

  /** Create or update one track and everything it references. Runs on the write queue. */
  private async writeTrack(
    id: string | null,
    p: ParsedTrack,
    file: TrackFile,
    art: { track: string | null; folder: string | null },
  ): Promise<string> {
    const db = this.deps.db;
    const albumArtistId = await this.upsertArtist(p.albumArtist);
    const creditIds: { artistId: string; role: string }[] = [];
    for (const c of p.credits) {
      const artistId = await this.upsertArtist(c.name);
      if (!creditIds.some((x) => x.artistId === artistId))
        creditIds.push({ artistId, role: c.role });
    }
    const genreIds = [...new Set(await Promise.all(p.genres.map((g) => this.upsertGenre(g))))];

    const albumArt = art.folder ?? art.track;
    const album = await db.album.upsert({
      where: { albumKey: albumKey(p.albumArtist, p.album) },
      create: {
        title: p.album,
        sortTitle: sortName(p.album),
        albumArtistId,
        albumKey: albumKey(p.albumArtist, p.album),
        year: p.year,
        isCompilation: p.isCompilation,
        artworkId: albumArt,
        replayGainDb: p.albumGainDb,
        replayPeak: p.albumPeak,
      },
      update: {},
      select: { id: true, artworkId: true, year: true, replayGainDb: true },
    });
    const albumPatch = {
      ...(art.folder && album.artworkId !== art.folder ? { artworkId: art.folder } : {}),
      ...(!album.artworkId && !art.folder && art.track ? { artworkId: art.track } : {}),
      ...(album.year === null && p.year !== null ? { year: p.year } : {}),
      ...(album.replayGainDb === null && p.albumGainDb !== null
        ? { replayGainDb: p.albumGainDb, replayPeak: p.albumPeak }
        : {}),
    };
    if (Object.keys(albumPatch).length > 0)
      await db.album.update({ where: { id: album.id }, data: albumPatch });

    const data = {
      title: p.title,
      sortTitle: sortName(p.title),
      albumId: album.id,
      artistId: creditIds[0]!.artistId,
      artistDisplay: p.artistDisplay,
      trackNumber: p.trackNumber,
      discNumber: p.discNumber,
      year: p.year,
      durationMs: p.durationMs,
      ...file,
      missingSince: null,
      container: p.container,
      codec: p.codec,
      bitrate: p.bitrate,
      sampleRate: p.sampleRate,
      bitDepth: p.bitDepth,
      channels: p.channels,
      lossless: p.lossless,
      replayGainDb: p.replayGainDb,
      replayPeak: p.replayPeak,
      loudnessSource: p.replayGainDb !== null ? ('TAG' as const) : null,
      artworkId: art.track,
    };

    const trackId = await db.$transaction(async (tx) => {
      let previousAlbumId: string | null = null;
      let tid: string;
      if (id) {
        const before = await tx.track.findUnique({ where: { id }, select: { albumId: true } });
        previousAlbumId = before?.albumId ?? null;
        tid = (await tx.track.update({ where: { id }, data, select: { id: true } })).id;
        await tx.trackArtist.deleteMany({ where: { trackId: tid } });
        await tx.trackGenre.deleteMany({ where: { trackId: tid } });
      } else {
        tid = (await tx.track.create({ data, select: { id: true } })).id;
      }
      await tx.trackArtist.createMany({
        data: creditIds.map((c, i) => ({
          trackId: tid,
          artistId: c.artistId,
          role: c.role,
          position: i,
        })),
      });
      if (genreIds.length) {
        await tx.trackGenre.createMany({
          data: genreIds.map((genreId) => ({ trackId: tid, genreId })),
        });
      }
      if (previousAlbumId) this.touched.albums.add(previousAlbumId);
      return tid;
    });
    this.markTouched(trackId, album.id);
    return trackId;
  }

  // ───────────── removal & finalisation ─────────────

  private async markMissing(tracks: KnownTrack[]): Promise<void> {
    if (!tracks.length) return;
    await this.deps.db.track.updateMany({
      where: { id: { in: tracks.map((t) => t.id) }, missingSince: null },
      data: { missingSince: new Date() },
    });
    for (const t of tracks) this.markTouched(t.id, t.albumId);
    this.counters.removed += tracks.length;
  }

  /** Credited artists' visibility depends on their tracks, so refresh them in search too. */
  private async touchCreditedArtists(trackIds: string[]): Promise<void> {
    if (!trackIds.length) return;
    const credits = await this.deps.db.trackArtist.findMany({
      where: { trackId: { in: trackIds } },
      select: { artistId: true },
    });
    for (const c of credits) this.touched.artists.add(c.artistId);
  }

  private async finish(): Promise<void> {
    // Before purging, while the credit rows still exist.
    await this.touchCreditedArtists([...this.touched.tracks]);
    await this.purgeExpired();
    await this.recomputeAlbums([...this.touched.albums]);
    await this.deleteOrphans();
    this.deps.artwork.reset();
    this.deps.log.info(
      {
        ...this.counters,
        errors: this.counters.errors.length,
        ms: Date.now() - this.startedAt.getTime(),
      },
      'scan: finished',
    );
  }

  /** Hard-delete tracks missing for longer than the grace period (disabled when 0). */
  private async purgeExpired(): Promise<void> {
    if (this.deps.missingGraceDays <= 0) return;
    const cutoff = new Date(Date.now() - this.deps.missingGraceDays * 86_400_000);
    const expired = await this.deps.db.track.findMany({
      where: { missingSince: { lte: cutoff } },
      select: { id: true, albumId: true },
    });
    if (!expired.length) return;
    await this.touchCreditedArtists(expired.map((t) => t.id));
    await this.deps.db.track.deleteMany({ where: { id: { in: expired.map((t) => t.id) } } });
    for (const t of expired) this.markTouched(t.id, t.albumId);
  }

  /** Denormalised album fields: counts and duration over *present* tracks. */
  private async recomputeAlbums(albumIds: string[]): Promise<void> {
    for (const albumId of albumIds) {
      const agg = await this.deps.db.track.aggregate({
        where: { albumId, missingSince: null },
        _count: true,
        _sum: { durationMs: true },
        _max: { discNumber: true },
      });
      const album = await this.deps.db.album.findUnique({
        where: { id: albumId },
        select: { albumArtistId: true },
      });
      if (!album) continue;
      this.touched.artists.add(album.albumArtistId);
      await this.deps.db.album.update({
        where: { id: albumId },
        data: {
          trackCount: agg._count,
          durationMs: agg._sum.durationMs ?? 0,
          discCount: agg._max.discNumber ?? 1,
        },
      });
    }
  }

  /** Albums with no tracks at all (present or missing), then artists and genres nobody references. */
  private async deleteOrphans(): Promise<void> {
    const db = this.deps.db;
    const albums = await db.album.findMany({
      where: { tracks: { none: {} } },
      select: { id: true, albumArtistId: true },
    });
    if (albums.length) {
      await db.album.deleteMany({ where: { id: { in: albums.map((a) => a.id) } } });
      for (const a of albums) {
        this.touched.albums.add(a.id);
        this.touched.artists.add(a.albumArtistId);
      }
    }
    const artists = await db.artist.findMany({
      where: { albums: { none: {} }, tracks: { none: {} }, trackCredits: { none: {} } },
      select: { id: true },
    });
    if (artists.length) {
      await db.artist.deleteMany({ where: { id: { in: artists.map((a) => a.id) } } });
      for (const a of artists) this.touched.artists.add(a.id);
    }
    await db.genre.deleteMany({ where: { tracks: { none: {} } } });
  }
}

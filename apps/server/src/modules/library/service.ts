import type { FastifyBaseLogger } from 'fastify';
import type { LibraryStatsDto, MissingTrackDto, Page, ScanRunDto } from '@tidepool/shared';
import type { Db } from '../../db.js';
import type { Env } from '../../env.js';
import { conflict, notFound } from '../../errors.js';
import type { ScanRun } from '../../generated/prisma/client.js';
import type { ArtworkStore } from './artwork.js';
import type { SearchIndexer } from './indexer.js';
import { Scanner, type ScanCounters } from './scanner.js';

export type ScanTrigger = 'startup' | 'manual' | 'watcher' | 'purge';

type Job =
  | { kind: 'full'; forceReread: boolean }
  | { kind: 'paths'; changed: string[]; removed: string[] }
  | { kind: 'purge'; ids: string[] | null };

function toDto(run: ScanRun, live?: ScanCounters): ScanRunDto {
  const c = live ?? {
    filesSeen: run.filesSeen,
    added: run.added,
    updated: run.updated,
    moved: run.moved,
    removed: run.removed,
    errors: run.errors as unknown as ScanRunDto['errors'],
  };
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    filesSeen: c.filesSeen,
    added: c.added,
    updated: c.updated,
    moved: c.moved,
    removed: c.removed,
    errors: c.errors,
  };
}

/**
 * Owns scanning: at most one scan runs at a time. Manual full scans are rejected while
 * one is running; watcher batches queue up behind the current scan instead.
 */
export class LibraryService {
  private chain: Promise<void> = Promise.resolve();
  private current: { runId: string; scanner: Scanner } | null = null;
  private pendingFull = false;

  constructor(
    private readonly deps: {
      db: Db;
      env: Pick<Env, 'MUSIC_DIR' | 'SCAN_CONCURRENCY' | 'MISSING_GRACE_DAYS'>;
      artwork: ArtworkStore;
      indexer: SearchIndexer;
      log: FastifyBaseLogger;
      /** Called after each successful scan (e.g. to analyse loudness of new tracks). */
      onScanComplete?: () => void;
    },
  ) {}

  get isScanning(): boolean {
    return this.current !== null || this.pendingFull;
  }

  /** Start a full scan in the background. Resolves with the run id once it is recorded. */
  async startFullScan(trigger: ScanTrigger, forceReread = false): Promise<string> {
    if (this.isScanning && trigger === 'manual') {
      throw conflict('A scan is already running', { scanId: this.current?.runId ?? null });
    }
    this.pendingFull = true;
    const run = await this.deps.db.scanRun.create({ data: { trigger } });
    this.enqueue(run.id, { kind: 'full', forceReread }).finally(() => {
      this.pendingFull = false;
    });
    return run.id;
  }

  /** Incremental scan for watcher events. Queued; returns a promise for the scan's completion. */
  async scanPaths(changed: string[], removed: string[]): Promise<string> {
    const run = await this.deps.db.scanRun.create({ data: { trigger: 'watcher' } });
    await this.enqueue(run.id, { kind: 'paths', changed, removed });
    return run.id;
  }

  /** Delete missing tracks (all, or specific ids). Waits for any running scan first. */
  async purgeMissing(ids: string[] | null): Promise<ScanRunDto> {
    const run = await this.deps.db.scanRun.create({ data: { trigger: 'purge' } });
    await this.enqueue(run.id, { kind: 'purge', ids });
    return this.getScan(run.id);
  }

  async listMissing(cursor: string | undefined, limit: number): Promise<Page<MissingTrackDto>> {
    const rows = await this.deps.db.track.findMany({
      where: { missingSince: { not: null } },
      orderBy: [{ missingSince: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        artistDisplay: true,
        path: true,
        missingSince: true,
        album: { select: { id: true, title: true } },
        _count: { select: { playlistTracks: true, likes: true, plays: true } },
      },
    });
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title,
      artistDisplay: r.artistDisplay,
      album: r.album,
      path: r.path,
      missingSince: r.missingSince!.toISOString(),
      playlistEntries: r._count.playlistTracks,
      liked: r._count.likes > 0,
      plays: r._count.plays,
    }));
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  /** Wait for every queued scan to finish (tests, graceful shutdown). */
  async idle(): Promise<void> {
    let last: Promise<void>;
    do {
      last = this.chain;
      await last;
    } while (last !== this.chain);
  }

  private enqueue(runId: string, job: Job): Promise<void> {
    const next = this.chain.then(() => this.execute(runId, job));
    this.chain = next.catch(() => undefined);
    return this.chain;
  }

  private async execute(runId: string, job: Job): Promise<void> {
    const { db, env, artwork, indexer, log } = this.deps;
    const scanner = new Scanner(
      {
        db,
        artwork,
        log,
        musicDir: env.MUSIC_DIR,
        concurrency: env.SCAN_CONCURRENCY,
        missingGraceDays: env.MISSING_GRACE_DAYS,
      },
      { forceReread: job.kind === 'full' && job.forceReread },
    );
    this.current = { runId, scanner };
    const progress = setInterval(() => void this.persist(runId, scanner.counters, 'RUNNING'), 2000);
    try {
      if (job.kind === 'full') await scanner.full();
      else if (job.kind === 'paths') await scanner.paths(job.changed, job.removed);
      else await scanner.purgeMissing(job.ids);

      try {
        await indexer.syncTracks([...scanner.touched.tracks]);
        await indexer.syncAlbums([...scanner.touched.albums]);
        await indexer.syncArtists([...scanner.touched.artists]);
      } catch (err) {
        // The library is still correct in Postgres; search catches up on the next scan/boot.
        log.error({ err }, 'scan: search indexing failed');
        scanner.counters.errors.push({ path: '(search index)', message: (err as Error).message });
      }
      await this.persist(runId, scanner.counters, 'COMPLETED');
      this.deps.onScanComplete?.();
    } catch (err) {
      log.error({ err }, 'scan: failed');
      scanner.counters.errors.push({ path: '(scan)', message: (err as Error).message });
      await this.persist(runId, scanner.counters, 'FAILED');
    } finally {
      clearInterval(progress);
      this.current = null;
    }
  }

  private async persist(
    runId: string,
    c: ScanCounters,
    status: 'RUNNING' | 'COMPLETED' | 'FAILED',
  ) {
    await this.deps.db.scanRun
      .update({
        where: { id: runId },
        data: {
          status,
          filesSeen: c.filesSeen,
          added: c.added,
          updated: c.updated,
          moved: c.moved,
          removed: c.removed,
          errors: c.errors as unknown as object[],
          ...(status !== 'RUNNING' ? { finishedAt: new Date() } : {}),
        },
      })
      .catch((err: unknown) => this.deps.log.warn({ err }, 'scan: failed to persist progress'));
  }

  async getScan(id: string): Promise<ScanRunDto> {
    const run = await this.deps.db.scanRun.findUnique({ where: { id } });
    if (!run) throw notFound('Scan');
    const live = this.current?.runId === id ? this.current.scanner.counters : undefined;
    return toDto(run, live);
  }

  async listScans(limit = 20): Promise<ScanRunDto[]> {
    const runs = await this.deps.db.scanRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return runs.map((r) =>
      toDto(r, this.current?.runId === r.id ? this.current.scanner.counters : undefined),
    );
  }

  async stats(): Promise<LibraryStatsDto> {
    const db = this.deps.db;
    const [agg, missingTracks, albums, artists, genres] = await Promise.all([
      db.track.aggregate({
        where: { missingSince: null },
        _count: true,
        _sum: { durationMs: true, fileSize: true },
      }),
      db.track.count({ where: { missingSince: { not: null } } }),
      db.album.count({ where: { trackCount: { gt: 0 } } }),
      db.artist.count({
        where: {
          OR: [
            { albums: { some: { trackCount: { gt: 0 } } } },
            { trackCredits: { some: { track: { missingSince: null } } } },
          ],
        },
      }),
      db.genre.count(),
    ]);
    return {
      tracks: agg._count,
      albums,
      artists,
      genres,
      missingTracks,
      totalDurationMs: agg._sum.durationMs ?? 0,
      totalSizeBytes: Number(agg._sum.fileSize ?? 0n),
    };
  }
}

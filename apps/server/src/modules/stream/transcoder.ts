import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import PQueue from 'p-queue';
import type { FastifyBaseLogger } from 'fastify';
import { TRANSCODE_PROFILES, type TranscodeProfileId } from '@tidepool/shared';
import type { Db } from '../../db.js';

export interface TranscodeSource {
  id: string;
  /** Absolute, already validated to be inside MUSIC_DIR. */
  absPath: string;
  quickHash: string;
}

export interface CachedTranscode {
  file: string;
  sizeBytes: number;
  sourceHash: string;
}

export class TranscodeError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'TranscodeError';
  }
}

/** Live output kept in memory while a job runs, so every listener can stream from byte 0. */
const MAX_LIVE_BUFFER_BYTES = 96 << 20;
/** After a failure, don't retry the same (track, profile) for this long. */
const FAILURE_BACKOFF_MS = 10 * 60_000;
/** lastAccessedAt is only rewritten when older than this (media players issue many Range requests). */
const TOUCH_INTERVAL_MS = 60 * 60_000;

function codecArgs(profileId: TranscodeProfileId): string[] {
  const p = TRANSCODE_PROFILES[profileId];
  switch (p.codec) {
    case 'opus':
      return [
        '-c:a',
        'libopus',
        '-b:a',
        `${p.kbps}k`,
        '-vbr',
        'on',
        '-application',
        'audio',
        '-ac',
        '2',
      ];
    case 'aac':
      return ['-c:a', 'aac', '-b:a', `${p.kbps}k`, '-ac', '2'];
    case 'flac':
      return ['-c:a', 'flac', '-compression_level', '5'];
  }
}

/** [muxer for the seekable cache file, muxer for the live stream, extra cache muxer options] */
function muxers(profileId: TranscodeProfileId): {
  cache: string;
  live: string;
  cacheOpts: string[];
} {
  switch (TRANSCODE_PROFILES[profileId].codec) {
    case 'opus':
      return { cache: 'webm', live: 'webm', cacheOpts: [] };
    case 'aac':
      // MP4 with the index up front for the cache (best seeking); ADTS for streaming.
      return { cache: 'ipod', live: 'adts', cacheOpts: ['movflags=+faststart'] };
    case 'flac':
      return { cache: 'flac', live: 'flac', cacheOpts: [] };
  }
}

/** One running transcode. Exposed so routes can stream its live output. */
export class TranscodeJob extends EventEmitter {
  readonly chunks: Buffer[] = [];
  bufferedBytes = 0;
  /** False once the live buffer overflowed; late listeners must wait for the cache. */
  liveAvailable: boolean;
  /** The live buffer exceeded its cap and was dropped. */
  overflowed = false;
  finished = false;
  error: Error | null = null;
  readonly done: Promise<CachedTranscode>;

  constructor(
    readonly key: string,
    live: boolean,
    run: (job: TranscodeJob) => Promise<CachedTranscode>,
  ) {
    super();
    this.setMaxListeners(0);
    this.liveAvailable = live;
    this.done = run(this).then(
      (r) => {
        this.finished = true;
        this.emit('end');
        return r;
      },
      (err: Error) => {
        this.finished = true;
        this.error = err;
        this.emit('end');
        throw err;
      },
    );
    this.done.catch(() => undefined); // callers handle it; avoid unhandled rejections
  }

  pushLive(chunk: Buffer): void {
    if (!this.liveAvailable) return;
    if (this.bufferedBytes + chunk.length > MAX_LIVE_BUFFER_BYTES) {
      this.liveAvailable = false;
      this.overflowed = true;
      this.chunks.length = 0;
      this.emit('data');
      return;
    }
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
    this.emit('data');
  }

  /**
   * A stream of the live output from byte 0. Resolves once the first bytes exist (so callers
   * can still return an error status if ffmpeg fails immediately), or rejects if the job fails
   * before producing any audio.
   */
  async openLiveStream(): Promise<Readable> {
    await new Promise<void>((resolve) => {
      if (this.chunks.length || this.finished) return resolve();
      const check = () => {
        if (this.chunks.length || this.finished) {
          this.off('data', check).off('end', check);
          resolve();
        }
      };
      this.on('data', check).on('end', check);
    });
    if (this.error && this.chunks.length === 0) throw this.error;

    let index = 0;
    let waiting = false;
    const onEvent = () => {
      waiting = false;
      this.off('data', onEvent).off('end', onEvent);
      pump();
    };
    const stream = new Readable({
      read: () => pump(),
      destroy: (err, cb) => {
        this.off('data', onEvent).off('end', onEvent);
        cb(err);
      },
    });
    const pump = (): void => {
      if (this.overflowed) {
        // Buffer overflowed (very long lossless track): this listener has to retry once cached.
        stream.destroy(new TranscodeError('live transcode buffer exceeded'));
        return;
      }
      while (index < this.chunks.length) {
        if (!stream.push(this.chunks[index++])) return;
      }
      if (this.finished) {
        if (this.error) stream.destroy(this.error);
        else stream.push(null);
        return;
      }
      if (!waiting) {
        waiting = true;
        this.on('data', onEvent).on('end', onEvent);
      }
    };
    return stream;
  }
}

/**
 * Owns the transcode cache under $DATA_DIR/transcode. At most one job per (track, profile)
 * runs at a time, and at most `concurrency` jobs overall.
 */
export class Transcoder {
  private readonly jobs = new Map<string, TranscodeJob>();
  private readonly failures = new Map<string, number>();
  private readonly queue: PQueue;
  private readonly root: string;
  private readonly tmpDir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly log: FastifyBaseLogger,
    private readonly opts: {
      concurrency: number;
      maxBytes: number;
      timeoutMs: number;
      ffmpegPath?: string;
    },
  ) {
    this.queue = new PQueue({ concurrency: opts.concurrency });
    this.root = path.join(dataDir, 'transcode');
    this.tmpDir = path.join(this.root, 'tmp');
  }

  static key(trackId: string, profile: TranscodeProfileId): string {
    return `${trackId}:${profile}`;
  }

  /** Clear out partial files from a previous run and files whose track no longer exists. */
  async init(): Promise<void> {
    await fs.rm(this.tmpDir, { recursive: true, force: true });
    await fs.mkdir(this.tmpDir, { recursive: true });
    const dirs = (await fs.readdir(this.root)).filter((d) => d !== 'tmp');
    if (!dirs.length) return;
    const known = new Set(
      (await this.db.track.findMany({ where: { id: { in: dirs } }, select: { id: true } })).map(
        (t) => t.id,
      ),
    );
    for (const d of dirs) {
      if (!known.has(d)) await fs.rm(path.join(this.root, d), { recursive: true, force: true });
    }
  }

  isBackingOff(trackId: string, profile: TranscodeProfileId): boolean {
    const until = this.failures.get(Transcoder.key(trackId, profile));
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.failures.delete(Transcoder.key(trackId, profile));
    return false;
  }

  /** The cached file if present and made from the current source; stale entries are removed. */
  async lookup(
    track: TranscodeSource,
    profile: TranscodeProfileId,
  ): Promise<CachedTranscode | null> {
    const entry = await this.db.transcodeCache.findUnique({
      where: { trackId_profile: { trackId: track.id, profile } },
    });
    if (!entry) return null;
    const file = path.join(path.dirname(this.root), entry.path);
    const stat = await fs.stat(file).catch(() => null);
    if (entry.sourceHash !== track.quickHash || !stat) {
      await this.remove(entry.id, file);
      return null;
    }
    if (Date.now() - entry.lastAccessedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.transcodeCache
        .update({ where: { id: entry.id }, data: { lastAccessedAt: new Date() } })
        .catch(() => undefined);
    }
    return { file, sizeBytes: stat.size, sourceHash: entry.sourceHash };
  }

  /** The running job for this key, if any. */
  running(trackId: string, profile: TranscodeProfileId): TranscodeJob | undefined {
    return this.jobs.get(Transcoder.key(trackId, profile));
  }

  /**
   * Start (or join) a transcode. With `live`, a newly started job also keeps its output in
   * memory for streaming; joining a job started without `live` gives no live stream.
   */
  ensure(track: TranscodeSource, profile: TranscodeProfileId, { live = false } = {}): TranscodeJob {
    const key = Transcoder.key(track.id, profile);
    const existing = this.jobs.get(key);
    if (existing) return existing;

    const job = new TranscodeJob(key, live, (j) =>
      this.queue.add(() => this.run(j, track, profile)),
    );
    this.jobs.set(key, job);
    void job.done
      .catch((err: unknown) => {
        this.failures.set(key, Date.now() + FAILURE_BACKOFF_MS);
        this.log.warn({ err, trackId: track.id, profile }, 'transcode failed');
      })
      .finally(() => this.jobs.delete(key));
    return job;
  }

  private async run(
    job: TranscodeJob,
    track: TranscodeSource,
    profile: TranscodeProfileId,
  ): Promise<CachedTranscode> {
    const def = TRANSCODE_PROFILES[profile];
    const mux = muxers(profile);
    await fs.mkdir(this.tmpDir, { recursive: true });
    // ffmpeg runs inside tmpDir with a plain relative name, so nothing in DATA_DIR needs escaping
    // for the tee muxer's syntax.
    const tmpName = `${track.id}-${profile}-${randomBytes(4).toString('hex')}.${def.ext}`;
    const tmpFile = path.join(this.tmpDir, tmpName);
    const live = job.liveAvailable;

    const output = live
      ? [
          '-f',
          'tee',
          `[f=${mux.live}:onfail=ignore]pipe:1|[${['f=' + mux.cache, ...mux.cacheOpts].join(':')}]${tmpName}`,
        ]
      : [
          '-f',
          mux.cache,
          ...mux.cacheOpts.flatMap((o) => {
            const [k, v] = o.split('=');
            return [`-${k}`, v!];
          }),
          tmpName,
        ];
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      `file:${track.absPath}`,
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      ...codecArgs(profile),
      ...output,
    ];

    const started = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.opts.ffmpegPath ?? 'ffmpeg', args, {
          cwd: this.tmpDir,
          stdio: ['ignore', live ? 'pipe' : 'ignore', 'pipe'],
        });
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), this.opts.timeoutMs);
        child.stdout?.on('data', (c: Buffer) => job.pushLive(c));
        child.stderr?.on('data', (d: Buffer) => {
          if (stderr.length < 16_384) stderr += d.toString();
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(new TranscodeError(`ffmpeg failed to start: ${err.message}`));
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else {
            const reason = signal
              ? `killed (${signal}${signal === 'SIGKILL' ? ', timeout' : ''})`
              : `exit ${code}`;
            reject(
              new TranscodeError(
                `ffmpeg ${reason}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`,
                stderr,
              ),
            );
          }
        });
      });

      const stat = await fs.stat(tmpFile);
      if (stat.size === 0) throw new TranscodeError('ffmpeg produced an empty file');
      const rel = path.join('transcode', track.id, `${profile}.${def.ext}`);
      const final = path.join(path.dirname(this.root), rel);
      await fs.mkdir(path.dirname(final), { recursive: true });
      await fs.rename(tmpFile, final);
      await this.db.transcodeCache.upsert({
        where: { trackId_profile: { trackId: track.id, profile } },
        create: {
          trackId: track.id,
          profile,
          sourceHash: track.quickHash,
          path: rel,
          sizeBytes: BigInt(stat.size),
        },
        update: {
          sourceHash: track.quickHash,
          path: rel,
          sizeBytes: BigInt(stat.size),
          lastAccessedAt: new Date(),
        },
      });
      this.log.info(
        { trackId: track.id, profile, ms: Date.now() - started, bytes: stat.size },
        'transcoded',
      );
      void this.evict().catch((err: unknown) =>
        this.log.warn({ err }, 'transcode cache eviction failed'),
      );
      return { file: final, sizeBytes: stat.size, sourceHash: track.quickHash };
    } catch (err) {
      await fs.rm(tmpFile, { force: true });
      throw err;
    }
  }

  /** Delete least-recently-used entries until the cache fits under maxBytes. */
  async evict(): Promise<number> {
    let removed = 0;
    for (;;) {
      const total = Number(
        (await this.db.transcodeCache.aggregate({ _sum: { sizeBytes: true } }))._sum.sizeBytes ??
          0n,
      );
      if (total <= this.opts.maxBytes) return removed;
      const victims = await this.db.transcodeCache.findMany({
        orderBy: { lastAccessedAt: 'asc' },
        take: 20,
      });
      let freed = 0;
      for (const v of victims) {
        if (this.jobs.has(Transcoder.key(v.trackId, v.profile as TranscodeProfileId))) continue;
        await this.remove(v.id, path.join(path.dirname(this.root), v.path));
        freed += Number(v.sizeBytes);
        removed++;
        if (total - freed <= this.opts.maxBytes) return removed;
      }
      if (freed === 0) return removed; // only in-use entries left
    }
  }

  private async remove(id: string, file: string): Promise<void> {
    await this.db.transcodeCache.deleteMany({ where: { id } });
    await fs.rm(file, { force: true });
  }

  /** Wait for running jobs (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
  }
}

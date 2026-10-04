import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db.js';
import { run } from '../../lib/process.js';
import { resolveRealInside } from '../../lib/safe-path.js';

/** ReplayGain 2.0 reference level. */
export const REFERENCE_LUFS = -18;

export interface LoudnessResult {
  integratedLufs: number;
  truePeakDb: number;
}

/** Parse the summary ffmpeg's ebur128 filter prints at the end of a run. */
export function parseEbur128Summary(stderr: string): LoudnessResult | null {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
  if (!i?.[1] || !peak?.[1] || i[1] === '-inf') return null; // silent file: no meaningful gain
  return {
    integratedLufs: Number(i[1]),
    truePeakDb: peak[1] === '-inf' ? -Infinity : Number(peak[1]),
  };
}

export async function measureLoudness(
  absPath: string,
  timeoutMs = 300_000,
): Promise<LoudnessResult | null> {
  const { stderr } = await run(
    'ffmpeg',
    [
      '-nostats',
      '-hide_banner',
      '-nostdin',
      '-i',
      `file:${absPath}`,
      '-map',
      '0:a:0',
      '-af',
      'ebur128=peak=true:framelog=verbose',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs },
  );
  return parseEbur128Summary(stderr);
}

/** Duration-weighted energy average of track loudness → album loudness. */
export function albumLoudness(tracks: { lufs: number; durationMs: number }[]): number | null {
  const total = tracks.reduce((s, t) => s + t.durationMs, 0);
  if (!tracks.length || total <= 0) return null;
  const energy = tracks.reduce((s, t) => s + (t.durationMs / total) * Math.pow(10, t.lufs / 10), 0);
  return 10 * Math.log10(energy);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Fills in loudness for tracks without ReplayGain tags, one file at a time in the background
 * (each analysis decodes the whole file). Album gain is derived once all of an album's tracks
 * have a measurement.
 */
export class LoudnessAnalyzer {
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly musicDir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Start (or schedule another pass of) the analysis. Safe to call after every scan. */
  kick(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun && !this.stopped);
    })()
      .catch((err: unknown) => this.log.error({ err }, 'loudness: pass failed'))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async pass(): Promise<void> {
    let analysed = 0;
    const touchedAlbums = new Set<string>();
    while (!this.stopped) {
      const batch = await this.db.track.findMany({
        where: { missingSince: null, replayGainDb: null, loudnessSource: null },
        select: { id: true, path: true, albumId: true },
        take: 20,
      });
      if (!batch.length) break;
      for (const t of batch) {
        if (this.stopped) break;
        let result: LoudnessResult | null = null;
        try {
          result = await measureLoudness(await resolveRealInside(this.musicDir, t.path));
        } catch (err) {
          this.log.warn({ err, trackId: t.id }, 'loudness: analysis failed');
        }
        // loudnessSource marks the track as attempted, so failures aren't retried every pass.
        await this.db.track.update({
          where: { id: t.id },
          data: result
            ? {
                loudnessSource: 'ANALYZED',
                loudnessLufs: round2(result.integratedLufs),
                replayGainDb: round2(REFERENCE_LUFS - result.integratedLufs),
                replayPeak: Number.isFinite(result.truePeakDb)
                  ? Math.pow(10, result.truePeakDb / 20)
                  : 0,
              }
            : { loudnessSource: 'ANALYZED' },
        });
        touchedAlbums.add(t.albumId);
        analysed++;
      }
    }
    for (const albumId of touchedAlbums) await this.updateAlbumGain(albumId);
    if (analysed) this.log.info({ analysed }, 'loudness: analysis pass complete');
  }

  private async updateAlbumGain(albumId: string): Promise<void> {
    const album = await this.db.album.findUnique({
      where: { id: albumId },
      select: { replayGainDb: true },
    });
    if (!album || album.replayGainDb !== null) return; // tagged album gain wins
    const tracks = await this.db.track.findMany({
      where: { albumId, missingSince: null },
      select: { loudnessLufs: true, durationMs: true, replayPeak: true },
    });
    if (tracks.some((t) => t.loudnessLufs === null)) return;
    const lufs = albumLoudness(
      tracks.map((t) => ({ lufs: t.loudnessLufs!, durationMs: t.durationMs })),
    );
    if (lufs === null) return;
    await this.db.album.update({
      where: { id: albumId },
      data: {
        replayGainDb: round2(REFERENCE_LUFS - lufs),
        replayPeak: Math.max(...tracks.map((t) => t.replayPeak ?? 0)),
      },
    });
  }
}

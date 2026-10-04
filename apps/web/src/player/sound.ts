/** Volume levelling, equaliser and crossfade maths, kept free of Web Audio so it can be tested. */

export interface LoudnessInfo {
  replayGainDb: number | null;
  replayPeak: number | null;
  albumGainDb: number | null;
  albumPeak: number | null;
}

/**
 * Gain to apply for ReplayGain. Album mode keeps the album's relative dynamics; falls back to
 * track gain when an album value is missing. Positive gain is limited so the peak can't clip.
 */
export function replayGainDb(
  l: LoudnessInfo | undefined,
  mode: 'track' | 'album',
  enabled: boolean,
): number {
  if (!enabled || !l) return 0;
  const useAlbum = mode === 'album' && l.albumGainDb !== null;
  const gain = (useAlbum ? l.albumGainDb : l.replayGainDb) ?? 0;
  const peak = (useAlbum ? l.albumPeak : l.replayPeak) ?? null;
  if (peak && peak > 0) {
    const headroom = -20 * Math.log10(peak);
    return Math.min(gain, headroom);
  }
  return Math.min(gain, 6); // unknown peak: be conservative about boosting
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_PRESETS: Record<string, readonly number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  'Late night': [4, 3, 1, 0, -1, -1, 0, 1, 3, 4],
  'Small speakers': [-6, -4, 0, 2, 3, 3, 2, 1, 0, 0],
  Acoustic: [3, 3, 2, 1, 1, 1, 2, 3, 2, 1],
  Electronic: [4, 3, 1, 0, -2, 1, 0, 1, 3, 4],
};

/** Filter type per band: shelves at the ends, peaking filters between. */
export function eqFilterType(index: number): BiquadFilterType {
  if (index === 0) return 'lowshelf';
  if (index === EQ_FREQUENCIES.length - 1) return 'highshelf';
  return 'peaking';
}

/**
 * Overall gain reduction so heavy EQ boosts don't clip: half the largest boost (shelving and
 * peaking filters rarely stack fully), never more than 6 dB.
 */
export function eqPreampDb(bands: readonly number[]): number {
  const maxBoost = Math.max(0, ...bands);
  return -Math.min(6, maxBoost / 2);
}

/** Equal-power fade curves (sum of powers stays 1, so loudness holds steady through a crossfade). */
export function equalPowerCurves(steps = 64): { fadeIn: Float32Array; fadeOut: Float32Array } {
  const fadeIn = new Float32Array(steps);
  const fadeOut = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1);
    fadeIn[i] = Math.sin((x * Math.PI) / 2);
    fadeOut[i] = Math.cos((x * Math.PI) / 2);
  }
  return { fadeIn, fadeOut };
}

/** Crossfading consecutive tracks of the same album would smear live/continuous albums. */
export function shouldCrossfade(
  crossfadeSec: number,
  current: { albumId: string | null } | null,
  next: { albumId: string | null } | null,
): boolean {
  if (crossfadeSec <= 0 || !current || !next) return false;
  return !(current.albumId && current.albumId === next.albumId);
}

import { describe, expect, it } from 'vitest';
import {
  EQ_FREQUENCIES,
  EQ_PRESETS,
  eqPreampDb,
  equalPowerCurves,
  replayGainDb,
  shouldCrossfade,
} from './sound.js';

const L = { replayGainDb: -7, replayPeak: 0.9, albumGainDb: -5, albumPeak: 0.95 };

describe('replayGainDb', () => {
  it('uses track or album gain and is 0 when disabled', () => {
    expect(replayGainDb(L, 'track', true)).toBe(-7);
    expect(replayGainDb(L, 'album', true)).toBe(-5);
    expect(replayGainDb(L, 'track', false)).toBe(0);
    expect(replayGainDb(undefined, 'track', true)).toBe(0);
  });

  it('falls back to track gain when album gain is missing', () => {
    expect(replayGainDb({ ...L, albumGainDb: null }, 'album', true)).toBe(-7);
  });

  it('limits boosts so the peak does not clip', () => {
    // peak 0.5 → 6.02 dB of headroom
    expect(replayGainDb({ ...L, replayGainDb: 9, replayPeak: 0.5 }, 'track', true)).toBeCloseTo(
      6.02,
      2,
    );
    expect(replayGainDb({ ...L, replayGainDb: 9, replayPeak: null }, 'track', true)).toBe(6);
  });
});

describe('equaliser', () => {
  it('every preset has one value per band within ±12 dB', () => {
    for (const bands of Object.values(EQ_PRESETS)) {
      expect(bands).toHaveLength(EQ_FREQUENCIES.length);
      for (const b of bands) expect(Math.abs(b)).toBeLessThanOrEqual(12);
    }
  });

  it('pre-amp compensates for boosts only', () => {
    expect(eqPreampDb([0, 0, 0])).toBeCloseTo(0);
    expect(eqPreampDb([6, -3])).toBe(-3);
    expect(eqPreampDb([12, 12])).toBe(-6);
  });
});

describe('crossfade', () => {
  it('equal-power curves keep total power at 1', () => {
    const { fadeIn, fadeOut } = equalPowerCurves(32);
    for (let i = 0; i < 32; i++) expect(fadeIn[i]! ** 2 + fadeOut[i]! ** 2).toBeCloseTo(1, 5);
    expect(fadeIn[0]).toBe(0);
    expect(fadeOut[31]).toBeCloseTo(0, 6);
  });

  it('is skipped between tracks of the same album', () => {
    expect(shouldCrossfade(5, { albumId: 'a' }, { albumId: 'a' })).toBe(false);
    expect(shouldCrossfade(5, { albumId: 'a' }, { albumId: 'b' })).toBe(true);
    expect(shouldCrossfade(0, { albumId: 'a' }, { albumId: 'b' })).toBe(false);
  });
});

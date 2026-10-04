import { describe, expect, it } from 'vitest';
import { albumLoudness, parseEbur128Summary } from './loudness.js';

const SAMPLE = `[Parsed_ebur128_0 @ 0x1] t: 2.9 TARGET:-23 LUFS M: -21.8 S:-120.7 I: -21.8 LUFS
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -21.8 LUFS
    Threshold: -31.8 LUFS

  True peak:
    Peak:      -18.1 dBFS`;

describe('parseEbur128Summary', () => {
  it('reads integrated loudness and true peak from the summary, not the frame log', () => {
    expect(parseEbur128Summary(SAMPLE)).toEqual({ integratedLufs: -21.8, truePeakDb: -18.1 });
  });

  it('returns null for silence or unparsable output', () => {
    expect(parseEbur128Summary('Summary:\n I: -inf LUFS\n Peak: -inf dBFS')).toBeNull();
    expect(parseEbur128Summary('nothing here')).toBeNull();
  });
});

describe('albumLoudness', () => {
  it('equals the track loudness when all tracks match', () => {
    expect(
      albumLoudness([
        { lufs: -14, durationMs: 1000 },
        { lufs: -14, durationMs: 3000 },
      ]),
    ).toBeCloseTo(-14, 6);
  });

  it('is an energy average weighted by duration (louder tracks dominate)', () => {
    const l = albumLoudness([
      { lufs: -10, durationMs: 1000 },
      { lufs: -20, durationMs: 1000 },
    ])!;
    expect(l).toBeCloseTo(-12.6, 1);
    expect(albumLoudness([])).toBeNull();
  });
});

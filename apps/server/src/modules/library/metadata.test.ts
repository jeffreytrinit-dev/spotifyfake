import { describe, expect, it } from 'vitest';
import { normalizeCodec, parseCredits } from './metadata.js';

describe('parseCredits', () => {
  it('splits featured artists out of the artist tag', () => {
    expect(parseCredits('Main feat. Guest A & Guest B', undefined, 'Song')).toEqual([
      { name: 'Main', role: 'main' },
      { name: 'Guest A', role: 'featured' },
      { name: 'Guest B', role: 'featured' },
    ]);
  });

  it('keeps "&" inside a main artist name', () => {
    expect(parseCredits('Simon & Garfunkel', undefined, 'Song')).toEqual([
      { name: 'Simon & Garfunkel', role: 'main' },
    ]);
  });

  it('credits "(feat. X)" from the title without dropping it from the title', () => {
    expect(parseCredits('Main', undefined, 'Song (feat. Guest)')).toEqual([
      { name: 'Main', role: 'main' },
      { name: 'Guest', role: 'featured' },
    ]);
  });

  it('prefers a multi-value ARTISTS tag and dedupes case-insensitively', () => {
    expect(parseCredits('A, B', ['A', 'B', 'b'], 'Song')).toEqual([
      { name: 'A', role: 'main' },
      { name: 'B', role: 'featured' },
    ]);
  });
});

describe('normalizeCodec', () => {
  it.each([
    ['MPEG 1 Layer 3', '.mp3', 'mp3'],
    ['FLAC', '.flac', 'flac'],
    ['MPEG-4/AAC', '.m4a', 'aac'],
    ['ALAC', '.m4a', 'alac'],
    ['Opus', '.opus', 'opus'],
    ['Vorbis I', '.ogg', 'vorbis'],
    ['PCM', '.wav', 'pcm'],
    [undefined, '.wav', 'pcm'],
  ])('%s → %s', (raw, ext, expected) => {
    expect(normalizeCodec(raw, ext)).toBe(expected);
  });
});

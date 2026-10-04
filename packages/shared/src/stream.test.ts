import { describe, expect, it } from 'vitest';
import {
  adaptTier,
  detectPlayableFormats,
  planStream,
  ThroughputEstimator,
  type PlayableFormat,
  type SourceInfo,
} from './stream.js';

const DESKTOP: PlayableFormat[] = [
  'mp3',
  'aac',
  'mp4-aac',
  'flac',
  'ogg-opus',
  'ogg-vorbis',
  'webm-opus',
  'wav',
];
/** Worst case for an iPhone: no Opus, no Vorbis (newer iOS versions may report Opus too). */
const IPHONE: PlayableFormat[] = ['mp3', 'aac', 'mp4-aac', 'mp4-alac', 'flac', 'wav'];

const flac: SourceInfo = { container: 'flac', codec: 'flac', lossless: true, kbps: 900 };
const wav: SourceInfo = { container: 'wav', codec: 'pcm', lossless: true, kbps: 1411 };
const alac: SourceInfo = { container: 'mp4', codec: 'alac', lossless: true, kbps: 800 };
const mp3_320: SourceInfo = { container: 'mp3', codec: 'mp3', lossless: false, kbps: 320 };
const mp3_128: SourceInfo = { container: 'mp3', codec: 'mp3', lossless: false, kbps: 128 };
const vorbis_128: SourceInfo = { container: 'ogg', codec: 'vorbis', lossless: false, kbps: 128 };
const aac_256: SourceInfo = { container: 'mp4', codec: 'aac', lossless: false, kbps: 256 };

const original = (format: PlayableFormat) => ({ kind: 'original', format });
const transcode = (profile: string) => ({ kind: 'transcode', profile });

describe('planStream', () => {
  it.each([
    // [source, tier, client, expected]
    [flac, 'LOSSLESS', DESKTOP, original('flac')],
    [flac, 'HIGH', DESKTOP, transcode('opus320')],
    [flac, 'NORMAL', DESKTOP, transcode('opus160')],
    [flac, 'LOW', DESKTOP, transcode('opus96')],
    [flac, 'HIGH', IPHONE, transcode('aac256')],
    [flac, 'LOW', IPHONE, transcode('aac96')],
    [wav, 'LOSSLESS', DESKTOP, transcode('flac')],
    [wav, 'LOSSLESS', IPHONE, transcode('flac')],
    [wav, 'NORMAL', DESKTOP, transcode('opus160')],
    [alac, 'LOSSLESS', IPHONE, original('mp4-alac')],
    [alac, 'LOSSLESS', DESKTOP, transcode('flac')],
    // never transcode up
    [mp3_320, 'HIGH', DESKTOP, original('mp3')],
    [mp3_320, 'LOSSLESS', IPHONE, original('mp3')],
    [mp3_128, 'NORMAL', DESKTOP, original('mp3')],
    [mp3_128, 'LOW', DESKTOP, transcode('opus96')],
    [mp3_320, 'NORMAL', IPHONE, transcode('aac160')],
    [aac_256, 'HIGH', IPHONE, original('mp4-aac')],
    // compatibility transcodes don't inflate the bitrate
    [vorbis_128, 'HIGH', IPHONE, transcode('aac160')],
    [vorbis_128, 'LOSSLESS', IPHONE, transcode('aac160')],
    [vorbis_128, 'HIGH', DESKTOP, original('ogg-vorbis')],
  ] as const)('%#: %o at %s', (src, tier, client, expected) => {
    expect(planStream(src, tier, client)).toEqual(expected);
  });

  it('falls back to AAC for a client that declared nothing beyond the defaults', () => {
    expect(planStream(flac, 'HIGH', ['mp3', 'aac', 'mp4-aac'])).toEqual(transcode('aac256'));
    expect(planStream(flac, 'LOSSLESS', ['mp3', 'aac', 'mp4-aac'])).toEqual(transcode('aac256'));
  });

  it('allows VBR slack above the tier bitrate', () => {
    expect(planStream({ ...mp3_128, kbps: 175 }, 'NORMAL', DESKTOP)).toEqual(original('mp3'));
    expect(planStream({ ...mp3_128, kbps: 200 }, 'NORMAL', DESKTOP)).toEqual(transcode('opus160'));
  });
});

describe('detectPlayableFormats', () => {
  it('keeps formats canPlayType answers "maybe"/"probably" for', () => {
    const supported = new Set(['audio/mpeg', 'audio/flac']);
    expect(detectPlayableFormats((m) => (supported.has(m) ? 'maybe' : ''))).toEqual([
      'mp3',
      'flac',
    ]);
  });
});

describe('ThroughputEstimator', () => {
  const feed = (e: ThroughputEstimator, kbps: number, n: number) => {
    for (let i = 0; i < n; i++) e.addSample(256 * 1024, (256 * 1024 * 8) / kbps);
  };

  it('needs a minimum amount of data and ignores tiny samples', () => {
    const e = new ThroughputEstimator();
    e.addSample(1000, 1);
    expect(e.estimateKbps()).toBeNull();
    feed(e, 2000, 1);
    expect(e.estimateKbps()).toBeCloseTo(2000, 0);
  });

  it('reacts quickly to a drop and slowly to a recovery', () => {
    const e = new ThroughputEstimator();
    feed(e, 5000, 10);
    feed(e, 200, 2);
    const afterDrop = e.estimateKbps()!;
    expect(afterDrop).toBeLessThan(2000);
    feed(e, 5000, 1);
    expect(e.estimateKbps()!).toBeLessThan(4000);
  });
});

describe('adaptTier', () => {
  it('keeps the preferred tier with enough bandwidth or no estimate', () => {
    expect(adaptTier('HIGH', 'HIGH', 5000)).toBe('HIGH');
    expect(adaptTier('HIGH', 'HIGH', null)).toBe('HIGH');
  });

  it('drops straight to what the bandwidth supports', () => {
    expect(adaptTier('LOSSLESS', 'LOSSLESS', 300)).toBe('NORMAL'); // 160 × 1.5 = 240 ≤ 300
    expect(adaptTier('HIGH', 'HIGH', 300)).toBe('NORMAL');
    expect(adaptTier('HIGH', 'HIGH', 50)).toBe('LOW');
  });

  it('climbs one tier at a time and only with extra headroom', () => {
    expect(adaptTier('HIGH', 'LOW', 300)).toBe('LOW'); // 160 * 2.5 = 400 needed
    expect(adaptTier('HIGH', 'LOW', 450)).toBe('NORMAL');
    expect(adaptTier('HIGH', 'LOW', 10_000)).toBe('NORMAL');
  });

  it('never exceeds the preferred tier', () => {
    expect(adaptTier('NORMAL', 'HIGH', 10_000)).toBe('NORMAL');
  });
});

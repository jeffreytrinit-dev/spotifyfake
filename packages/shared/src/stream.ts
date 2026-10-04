/**
 * Streaming decisions shared by server and client.
 *
 * The server decides what to send for a (track, quality tier, client formats) triple with
 * `planStream`. Clients declare what they can decode with `detectPlayableFormats` (built on
 * `HTMLMediaElement.canPlayType`), so e.g. an iPhone without Opus support gets AAC automatically.
 */

export const QUALITY_TIERS = ['LOW', 'NORMAL', 'HIGH', 'LOSSLESS'] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Nominal bitrate of each lossy tier, in kbps. */
export const TIER_KBPS: Record<Exclude<QualityTier, 'LOSSLESS'>, number> = {
  LOW: 96,
  NORMAL: 160,
  HIGH: 320,
};

/** Rough bandwidth a tier needs; used by adaptive quality. Lossless assumes a typical 16/44.1 FLAC. */
export const TIER_REQUIRED_KBPS: Record<QualityTier, number> = { ...TIER_KBPS, LOSSLESS: 1100 };

/** Format keys a client can declare, with the MIME type used to probe for support. */
export const PLAYABLE_FORMATS = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  'mp4-aac': 'audio/mp4; codecs="mp4a.40.2"',
  'mp4-alac': 'audio/mp4; codecs="alac"',
  flac: 'audio/flac',
  'ogg-opus': 'audio/ogg; codecs="opus"',
  'ogg-vorbis': 'audio/ogg; codecs="vorbis"',
  'webm-opus': 'audio/webm; codecs="opus"',
  wav: 'audio/wav',
} as const;
export type PlayableFormat = keyof typeof PLAYABLE_FORMATS;
export const PLAYABLE_FORMAT_KEYS = Object.keys(PLAYABLE_FORMATS) as PlayableFormat[];

/** Assumed when a client doesn't say: formats every current browser plays. */
export const DEFAULT_PLAYABLE_FORMATS: readonly PlayableFormat[] = ['mp3', 'aac', 'mp4-aac'];

/** Client helper: `detectPlayableFormats((m) => new Audio().canPlayType(m))`. */
export function detectPlayableFormats(canPlayType: (mime: string) => string): PlayableFormat[] {
  return PLAYABLE_FORMAT_KEYS.filter((k) => canPlayType(PLAYABLE_FORMATS[k]) !== '');
}

export interface TranscodeProfile {
  codec: 'opus' | 'aac' | 'flac';
  kbps: number | null;
  /** Client must be able to play this for the profile to be chosen. */
  requires: PlayableFormat;
  /** Cached file (seekable). */
  ext: string;
  mime: string;
  /** Format streamed while the first transcode is still running (not seekable). */
  liveMime: string;
}

export const TRANSCODE_PROFILES = {
  opus96: {
    codec: 'opus',
    kbps: 96,
    requires: 'webm-opus',
    ext: 'webm',
    mime: 'audio/webm',
    liveMime: 'audio/webm',
  },
  opus160: {
    codec: 'opus',
    kbps: 160,
    requires: 'webm-opus',
    ext: 'webm',
    mime: 'audio/webm',
    liveMime: 'audio/webm',
  },
  opus320: {
    codec: 'opus',
    kbps: 320,
    requires: 'webm-opus',
    ext: 'webm',
    mime: 'audio/webm',
    liveMime: 'audio/webm',
  },
  aac96: {
    codec: 'aac',
    kbps: 96,
    requires: 'mp4-aac',
    ext: 'm4a',
    mime: 'audio/mp4',
    liveMime: 'audio/aac',
  },
  aac160: {
    codec: 'aac',
    kbps: 160,
    requires: 'mp4-aac',
    ext: 'm4a',
    mime: 'audio/mp4',
    liveMime: 'audio/aac',
  },
  aac256: {
    codec: 'aac',
    kbps: 256,
    requires: 'mp4-aac',
    ext: 'm4a',
    mime: 'audio/mp4',
    liveMime: 'audio/aac',
  },
  flac: {
    codec: 'flac',
    kbps: null,
    requires: 'flac',
    ext: 'flac',
    mime: 'audio/flac',
    liveMime: 'audio/flac',
  },
} as const satisfies Record<string, TranscodeProfile>;
export type TranscodeProfileId = keyof typeof TRANSCODE_PROFILES;
export const TRANSCODE_PROFILE_IDS = Object.keys(TRANSCODE_PROFILES) as TranscodeProfileId[];

const OPUS_LADDER = [
  [96, 'opus96'],
  [160, 'opus160'],
  [320, 'opus320'],
] as const;
const AAC_LADDER = [
  [96, 'aac96'],
  [160, 'aac160'],
  [256, 'aac256'],
] as const;

export interface SourceInfo {
  /** As stored on Track: "mp3" | "flac" | "mp4" | "aac" | "ogg" | "wav" */
  container: string;
  /** As stored on Track: "mp3" | "flac" | "aac" | "alac" | "opus" | "vorbis" | "pcm" */
  codec: string;
  lossless: boolean;
  /** Average bitrate of the original file. */
  kbps: number;
}

/** Which declared format the original file is, or null if it's something exotic. */
export function originalFormat(
  src: Pick<SourceInfo, 'container' | 'codec'>,
): PlayableFormat | null {
  const { container, codec } = src;
  if (codec === 'mp3') return 'mp3';
  if (container === 'flac' && codec === 'flac') return 'flac';
  if (container === 'wav') return 'wav';
  if (container === 'aac' && codec === 'aac') return 'aac';
  if (container === 'mp4' && codec === 'aac') return 'mp4-aac';
  if (container === 'mp4' && codec === 'alac') return 'mp4-alac';
  if (container === 'ogg' && codec === 'opus') return 'ogg-opus';
  if (container === 'ogg' && codec === 'vorbis') return 'ogg-vorbis';
  return null;
}

export type StreamPlan =
  { kind: 'original'; format: PlayableFormat } | { kind: 'transcode'; profile: TranscodeProfileId };

/** Originals up to this much over the tier's bitrate still count as "at or below" it (VBR slack). */
const BITRATE_TOLERANCE = 1.15;

/**
 * Decide what to send:
 *  - never transcode up: a lossy original at or below the tier (and playable) is sent as is;
 *  - lossless tier: playable lossless originals pass through, WAV becomes FLAC, otherwise FLAC;
 *  - otherwise transcode to the tier (or to the original's bitrate if that's lower, when a
 *    lossy file only needs re-encoding for compatibility), preferring Opus, falling back to AAC.
 */
export function planStream(
  src: SourceInfo,
  tier: QualityTier,
  playable: readonly PlayableFormat[],
): StreamPlan {
  const fmt = originalFormat(src);
  const canPlayOriginal = fmt !== null && playable.includes(fmt);
  const original = (): StreamPlan => ({ kind: 'original', format: fmt! });

  const lossy = (kbps: number): StreamPlan => {
    const ladder = playable.includes('webm-opus') ? OPUS_LADDER : AAC_LADDER;
    const rung = ladder.find(([k]) => k >= kbps) ?? ladder[ladder.length - 1]!;
    return { kind: 'transcode', profile: rung[1] };
  };

  if (tier === 'LOSSLESS') {
    if (src.lossless) {
      if (src.codec === 'pcm') {
        if (playable.includes('flac')) return { kind: 'transcode', profile: 'flac' };
        return canPlayOriginal ? original() : lossy(TIER_KBPS.HIGH);
      }
      if (canPlayOriginal) return original();
      return playable.includes('flac')
        ? { kind: 'transcode', profile: 'flac' }
        : lossy(TIER_KBPS.HIGH);
    }
    if (canPlayOriginal) return original();
    return lossy(Math.min(TIER_KBPS.HIGH, src.kbps));
  }

  const target = TIER_KBPS[tier];
  if (!src.lossless && canPlayOriginal && src.kbps <= target * BITRATE_TOLERANCE) return original();
  return lossy(src.lossless ? target : Math.min(target, src.kbps));
}

// ───────────────────────────── adaptive quality ─────────────────────────────

/**
 * Bandwidth estimate from download samples (bytes over milliseconds), using two exponentially
 * weighted averages: a fast one that reacts to drops and a slow one that resists spikes. The
 * estimate is the lower of the two, so quality drops quickly and recovers cautiously.
 */
export class ThroughputEstimator {
  private fast = new Ewma(2);
  private slow = new Ewma(5);
  /** Samples smaller than this are dominated by latency, not bandwidth. */
  static readonly MIN_SAMPLE_BYTES = 16 * 1024;

  addSample(bytes: number, ms: number): void {
    if (bytes < ThroughputEstimator.MIN_SAMPLE_BYTES || ms <= 0) return;
    const kbps = (bytes * 8) / ms; // bits per ms == kbps
    this.fast.add(kbps, bytes);
    this.slow.add(kbps, bytes);
  }

  /** kbps, or null until enough data has been seen. */
  estimateKbps(): number | null {
    if (this.slow.totalBytes < 128 * 1024) return null;
    return Math.min(this.fast.value, this.slow.value);
  }
}

class Ewma {
  private estimate = 0;
  private totalWeight = 0;
  totalBytes = 0;
  private readonly alpha: number;
  /** halfLife in "samples of 128 KiB" */
  constructor(halfLife: number) {
    this.alpha = Math.exp(Math.log(0.5) / halfLife);
  }
  add(value: number, bytes: number): void {
    const weight = bytes / (128 * 1024);
    const a = Math.pow(this.alpha, weight);
    this.estimate = value * (1 - a) + a * this.estimate;
    this.totalWeight += weight;
    this.totalBytes += bytes;
  }
  get value(): number {
    // Bias correction so early estimates aren't pulled towards 0.
    const zeroFactor = 1 - Math.pow(this.alpha, this.totalWeight);
    return zeroFactor > 0 ? this.estimate / zeroFactor : 0;
  }
}

/** Headroom the measured bandwidth must have over a tier's bitrate to keep it. */
export const DOWNGRADE_HEADROOM = 1.5;
/** Headroom needed to step back up (hysteresis, so quality doesn't flap). */
export const UPGRADE_HEADROOM = 2.5;

/**
 * Pick the tier to request next. Never above `preferred`. Drops straight to the best tier the
 * bandwidth supports; climbs one tier at a time, and only with clear headroom.
 */
export function adaptTier(
  preferred: QualityTier,
  current: QualityTier,
  estimateKbps: number | null,
): QualityTier {
  const idx = (t: QualityTier) => QUALITY_TIERS.indexOf(t);
  const cur = Math.min(idx(current), idx(preferred));
  if (estimateKbps === null) return QUALITY_TIERS[cur]!;

  const fits = (i: number, headroom: number) =>
    TIER_REQUIRED_KBPS[QUALITY_TIERS[i]!] * headroom <= estimateKbps;

  if (!fits(cur, DOWNGRADE_HEADROOM)) {
    let i = cur;
    while (i > 0 && !fits(i, DOWNGRADE_HEADROOM)) i--;
    return QUALITY_TIERS[i]!;
  }
  if (cur < idx(preferred) && fits(cur + 1, UPGRADE_HEADROOM)) return QUALITY_TIERS[cur + 1]!;
  return QUALITY_TIERS[cur]!;
}

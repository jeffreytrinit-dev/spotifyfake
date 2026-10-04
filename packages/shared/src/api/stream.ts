import { z } from 'zod';
import {
  PLAYABLE_FORMAT_KEYS,
  QUALITY_TIERS,
  type PlayableFormat,
  type TranscodeProfileId,
} from '../stream.js';

export const StreamQuerySchema = z.object({
  /** Defaults to the user's Wi-Fi quality setting. */
  q: z
    .string()
    .transform((s) => s.toUpperCase())
    .pipe(z.enum(QUALITY_TIERS))
    .optional(),
  /** Comma-separated PlayableFormat keys the client can decode. Unknown keys are ignored. */
  formats: z
    .string()
    .max(500)
    .transform((s) =>
      s
        .split(',')
        .map((f) => f.trim())
        .filter((f): f is PlayableFormat => (PLAYABLE_FORMAT_KEYS as string[]).includes(f)),
    )
    .optional(),
  /** Wait for an uncached transcode to finish and then serve it with Range support. */
  wait: z
    .enum(['1', 'true', '0', 'false'])
    .transform((v) => v === '1' || v === 'true')
    .optional(),
});
export type StreamQuery = z.infer<typeof StreamQuerySchema>;

export interface StreamInfoDto {
  trackId: string;
  tier: (typeof QUALITY_TIERS)[number];
  source: 'original' | 'transcode';
  /** Set for transcodes. */
  profile: TranscodeProfileId | null;
  codec: string;
  mime: string;
  /** Nominal bitrate in kbps; null for lossless. */
  kbps: number | null;
  lossless: boolean;
  /** True when bytes can be served with Range support right now (original or cached transcode). */
  seekable: boolean;
  sizeBytes: number | null;
}

import { z } from 'zod';
import { QUALITY_TIERS } from '../stream.js';

const Tier = z.enum(QUALITY_TIERS);

export const UserSettingsSchema = z.object({
  /** Used on Wi-Fi, or whenever the browser can't tell (iOS Safari never reports the connection type). */
  streamQualityWifi: Tier,
  streamQualityCell: Tier,
  downloadQuality: Tier,
  autoAdjustQuality: z.boolean(),
  crossfadeSeconds: z.number().int().min(0).max(12),
  gapless: z.boolean(),
  normalization: z.boolean(),
  normalizationMode: z.enum(['track', 'album']),
  eqEnabled: z.boolean(),
  eqPreset: z.string().max(40).nullable(),
  eqBands: z.array(z.number().min(-12).max(12)).length(10),
  theme: z.enum(['DARK', 'LIGHT', 'SYSTEM']),
  offlineStorageCapMb: z.number().int().min(100).max(1_000_000),
  fetchLyricsOnline: z.boolean(),
});
export type UserSettingsDto = z.infer<typeof UserSettingsSchema>;

export const UpdateUserSettingsSchema = UserSettingsSchema.partial().strict();
export type UpdateUserSettings = z.infer<typeof UpdateUserSettingsSchema>;

export const DEFAULT_EQ_BANDS: readonly number[] = Array.from({ length: 10 }, () => 0);

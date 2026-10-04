import { DEFAULT_EQ_BANDS, type UserSettingsDto } from '@tidepool/shared';
import type { Db } from '../../db.js';
import type { UserSettings } from '../../generated/prisma/client.js';

export function toSettingsDto(s: UserSettings): UserSettingsDto {
  return {
    streamQualityWifi: s.streamQualityWifi,
    streamQualityCell: s.streamQualityCell,
    downloadQuality: s.downloadQuality,
    autoAdjustQuality: s.autoAdjustQuality,
    crossfadeSeconds: s.crossfadeSeconds,
    gapless: s.gapless,
    normalization: s.normalization,
    normalizationMode: s.normalizationMode === 'album' ? 'album' : 'track',
    eqEnabled: s.eqEnabled,
    eqPreset: s.eqPreset,
    eqBands: s.eqBands.length === 10 ? s.eqBands : [...DEFAULT_EQ_BANDS],
    theme: s.theme,
    offlineStorageCapMb: s.offlineStorageCapMb,
    fetchLyricsOnline: s.fetchLyricsOnline,
  };
}

/** Settings row for a user, created with defaults on first access. */
export function getSettings(db: Db, userId: string): Promise<UserSettings> {
  return db.userSettings.upsert({ where: { userId }, create: { userId }, update: {} });
}

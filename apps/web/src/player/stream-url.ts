import type { PlayableFormat, QualityTier } from '@tidepool/shared';

export function streamUrl(
  trackId: string,
  tier: QualityTier,
  formats: readonly PlayableFormat[],
  wait = false,
): string {
  const q = new URLSearchParams({ q: tier.toLowerCase(), formats: formats.join(',') });
  if (wait) q.set('wait', '1');
  return `/api/v1/stream/${encodeURIComponent(trackId)}?${q.toString()}`;
}

export function artUrl(
  artworkId: string | null | undefined,
  size: 64 | 300 | 640 | 'orig',
): string | null {
  return artworkId ? `/api/v1/art/${encodeURIComponent(artworkId)}/${size}` : null;
}

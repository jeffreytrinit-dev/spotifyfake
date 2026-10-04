import {
  DEFAULT_PLAYABLE_FORMATS,
  detectPlayableFormats,
  type PlayableFormat,
} from '@tidepool/shared';

/** iPhone/iPad, including iPads that report themselves as Macs. */
export function isAppleMobile(
  nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator,
): boolean {
  if (/iPhone|iPad|iPod/.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1;
}

/** Running as an installed home-screen app rather than in a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

let cachedFormats: PlayableFormat[] | null = null;

/** What this browser can decode, asked once via canPlayType. */
export function playableFormats(): PlayableFormat[] {
  if (cachedFormats) return cachedFormats;
  try {
    const probe = document.createElement('audio');
    const found = detectPlayableFormats((m) => probe.canPlayType(m));
    cachedFormats = found.length ? found : [...DEFAULT_PLAYABLE_FORMATS];
  } catch {
    cachedFormats = [...DEFAULT_PLAYABLE_FORMATS];
  }
  return cachedFormats;
}

/** Cellular vs not. iOS Safari never exposes this, so iPhones always use the Wi-Fi setting. */
export function onCellular(): boolean {
  const c = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return c?.type === 'cellular';
}

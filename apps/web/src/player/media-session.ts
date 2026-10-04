import type { TrackDto } from '@tidepool/shared';
import { artUrl } from './stream-url.js';

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seekTo(ms: number): void;
}

const ms =
  typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;

/**
 * Lock screen / Control Center / headphone / keyboard media keys. Only previous/next and
 * seek-to are registered: on iOS, also registering seekbackward/seekforward replaces the
 * track buttons with ±10 s buttons.
 */
export function installMediaSession(h: MediaSessionHandlers): void {
  if (!ms) return;
  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // Unsupported action on this browser.
    }
  };
  set('play', () => h.play());
  set('pause', () => h.pause());
  set('stop', () => h.pause());
  set('nexttrack', () => h.next());
  set('previoustrack', () => h.previous());
  set('seekto', (d) => d.seekTime !== undefined && h.seekTo(d.seekTime * 1000));
}

export function setNowPlaying(track: TrackDto | undefined): void {
  if (!ms) return;
  if (!track) {
    ms.metadata = null;
    return;
  }
  const art = (size: 64 | 300 | 640) => ({
    src: new URL(artUrl(track.artworkId, size)!, location.origin).href,
    sizes: `${size}x${size}`,
    type: 'image/webp',
  });
  ms.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artistDisplay,
    album: track.album.title,
    artwork: track.artworkId ? [art(64), art(300), art(640)] : [],
  });
}

export function setPlaybackState(playing: boolean | null): void {
  if (ms) ms.playbackState = playing === null ? 'none' : playing ? 'playing' : 'paused';
}

export function setPosition(positionMs: number, durationMs: number): void {
  if (!ms?.setPositionState || durationMs <= 0) return;
  try {
    ms.setPositionState({
      duration: durationMs / 1000,
      position: Math.min(Math.max(0, positionMs), durationMs) / 1000,
      playbackRate: 1,
    });
  } catch {
    // Some browsers throw for transient invalid states; not worth surfacing.
  }
}

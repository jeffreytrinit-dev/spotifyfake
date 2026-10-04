import { useTrackCache } from '../player/track-cache.js';
import { usePlayer } from '../player/store.js';

/** Metadata for the current track (undefined while it loads). */
export function useCurrentTrack() {
  const id = usePlayer((s) => s.queue.current?.trackId);
  return useTrackCache((s) => (id ? s.byId[id] : undefined));
}

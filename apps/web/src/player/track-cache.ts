import { create } from 'zustand';
import type { Page, TrackDto } from '@tidepool/shared';
import { api } from '../api/client.js';

interface TrackCache {
  byId: Record<string, TrackDto>;
  put(tracks: TrackDto[]): void;
  /** Fetch any of these ids not yet cached (batched, 200 per request). */
  ensure(ids: readonly string[]): Promise<void>;
}

const inflight = new Set<string>();

/** Track metadata by id, filled from album pages and batch fetches for restored queues. */
export const useTrackCache = create<TrackCache>((set, get) => ({
  byId: {},
  put(tracks) {
    if (!tracks.length) return;
    set((s) => {
      const byId = { ...s.byId };
      for (const t of tracks) byId[t.id] = t;
      return { byId };
    });
  },
  async ensure(ids) {
    const missing = [...new Set(ids)].filter((id) => !get().byId[id] && !inflight.has(id));
    if (!missing.length) return;
    missing.forEach((id) => inflight.add(id));
    try {
      for (let i = 0; i < missing.length; i += 200) {
        const batch = missing.slice(i, i + 200);
        const page = await api<Page<TrackDto>>(`/tracks?ids=${batch.join(',')}`);
        get().put(page.items);
      }
    } finally {
      missing.forEach((id) => inflight.delete(id));
    }
  },
}));

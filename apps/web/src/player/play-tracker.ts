import type { PlayContext, PlayEventInput } from '@tidepool/shared';
import { api } from '../api/client.js';
import { storage } from '../lib/storage.js';

const OUTBOX = 'tp.plays.outbox';
/** Ignore plays shorter than this entirely (accidental taps). */
const MIN_RECORD_MS = 5_000;

interface Active {
  trackId: string;
  startedAt: string;
  durationMs: number;
  context: PlayContext | null;
  msPlayed: number;
  lastPos: number | null;
}

/**
 * Counts how long each track actually played (seeking doesn't count) and queues a play event
 * when it stops being the current track. Events wait in localStorage until the server accepts
 * them, so plays made offline are sent later.
 */
export class PlayTracker {
  private active: Active | null = null;
  private flushing = false;

  start(trackId: string, durationMs: number, context: PlayContext | null): void {
    this.active = {
      trackId,
      startedAt: new Date().toISOString(),
      durationMs,
      context,
      msPlayed: 0,
      lastPos: null,
    };
  }

  setDuration(trackId: string, durationMs: number): void {
    if (this.active?.trackId === trackId) this.active.durationMs = durationMs;
  }

  /** Feed playback positions while playing; only small forward steps count as listening. */
  tick(positionMs: number, playing: boolean): void {
    const a = this.active;
    if (!a) return;
    if (playing && a.lastPos !== null) {
      const delta = positionMs - a.lastPos;
      if (delta > 0 && delta < 2000) a.msPlayed += delta;
    }
    a.lastPos = playing ? positionMs : null;
  }

  /** The track stopped being current. `manual` = the user skipped it. */
  finish(manual: boolean): void {
    const a = this.active;
    this.active = null;
    if (!a || a.msPlayed < MIN_RECORD_MS) return;
    const percent = a.durationMs > 0 ? Math.min(1, a.msPlayed / a.durationMs) : 0;
    const event: PlayEventInput = {
      clientEventId: crypto.randomUUID(),
      trackId: a.trackId,
      startedAt: a.startedAt,
      msPlayed: Math.round(a.msPlayed),
      percentPlayed: Math.round(percent * 1000) / 1000,
      skipped: manual && percent < 0.5,
      ...(a.context ? { contextType: a.context.type } : {}),
      ...(a.context?.id ? { contextId: a.context.id } : {}),
      playedOffline: !navigator.onLine,
    };
    storage.set(OUTBOX, [...(storage.get<PlayEventInput[]>(OUTBOX) ?? []), event].slice(-5000));
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || !navigator.onLine) return;
    const pending = storage.get<PlayEventInput[]>(OUTBOX) ?? [];
    if (!pending.length) return;
    this.flushing = true;
    try {
      const batch = pending.slice(0, 200);
      await api('/plays', { method: 'POST', body: { events: batch } });
      const sent = new Set(batch.map((e) => e.clientEventId));
      storage.set(
        OUTBOX,
        (storage.get<PlayEventInput[]>(OUTBOX) ?? []).filter((e) => !sent.has(e.clientEventId)),
      );
    } catch {
      // Keep them for the next attempt.
    } finally {
      this.flushing = false;
    }
  }
}

import { create } from 'zustand';
import type {
  PlayContext,
  PlayerStateDto,
  QualityTier,
  SavePlayerState,
  UserSettingsDto,
} from '@tidepool/shared';
import { api, ApiError } from '../api/client.js';
import { storage } from '../lib/storage.js';
import { AdaptiveQuality } from './bandwidth.js';
import { DEVICE_ID, useDeviceSettings } from './device.js';
import { DualEngine } from './engine/dual-engine.js';
import { ElementEngine } from './engine/element-engine.js';
import type { EngineCallbacks, EngineTrack, PlaybackEngine } from './engine/types.js';
import {
  installMediaSession,
  setNowPlaying,
  setPlaybackState,
  setPosition,
} from './media-session.js';
import { isAppleMobile, onCellular, playableFormats } from './platform.js';
import { PlayTracker } from './play-tracker.js';
import * as Q from './queue.js';
import { replayGainDb } from './sound.js';
import { streamUrl } from './stream-url.js';
import { useTrackCache } from './track-cache.js';

export interface PlayerStore {
  /** Call synchronously at the start of a tap handler that will start playback after async work. */
  unlockAudio(): void;
  queue: Q.QueueState;
  playing: boolean;
  buffering: boolean;
  positionMs: number;
  volume: number;
  muted: boolean;
  /** Reached the end of the queue. */
  ended: boolean;
  error: string | null;
  /** Quality tier used for the current track (after adaptive adjustment). */
  tier: QualityTier | null;
  engineKind: 'element' | 'dual' | null;

  playContext(
    context: PlayContext,
    trackIds: readonly string[],
    startIndex: number | null,
    opts?: { shuffle?: boolean },
  ): void;
  togglePlay(): void;
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seek(ms: number): void;
  seekBy(deltaMs: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  playNext(trackIds: readonly string[]): void;
  addToQueue(trackIds: readonly string[]): void;
  removeFromQueue(uid: string): void;
  clearQueue(): void;
  moveInQueue(fromUid: string, overUid: string): void;
  jumpTo(uid: string): void;
  dismissError(): void;
}

// ───────────────────────────── module state ─────────────────────────────

let engine: PlaybackEngine | null = null;
let settings: UserSettingsDto | null = null;
let userKey = 'anon';
/** Restored but not loaded into the engine yet (avoid streaming before the user presses play). */
let pendingRestore: { startMs: number } | null = null;
let errorStreak = 0;
/**
 * Whether the user wants audio playing. Differs from `playing` while a new source loads (the
 * element briefly reports "pause" when its src changes), so next/previous keep the user's intent.
 */
let wantPlay = false;
const adaptive = new AdaptiveQuality();
const tracker = new PlayTracker();

const LOCAL_KEY = () => `tp.player.v1.${userKey}`;

function preferredTier(): QualityTier {
  if (!settings) return 'HIGH';
  return onCellular() ? settings.streamQualityCell : settings.streamQualityWifi;
}

function gainFor(trackId: string): number {
  const t = useTrackCache.getState().byId[trackId];
  if (!settings || !engine?.canProcess) return 0;
  return replayGainDb(t?.loudness, settings.normalizationMode, settings.normalization);
}

function engineTrack(trackId: string): EngineTrack {
  const tier = adaptive.current(preferredTier(), settings?.autoAdjustQuality ?? true);
  const formats = playableFormats();
  const meta = useTrackCache.getState().byId[trackId];
  return {
    trackId,
    url: streamUrl(trackId, tier, formats),
    waitUrl: streamUrl(trackId, tier, formats, true),
    durationMs: meta?.durationMs ?? 0,
    gainDb: gainFor(trackId),
    albumId: meta?.album.id ?? null,
  };
}

export const usePlayer = create<PlayerStore>((set, get) => {
  const getEngine = (): PlaybackEngine => {
    if (engine) return engine;
    const cb: EngineCallbacks = {
      onTime: (ms) => {
        set({ positionMs: ms });
        tracker.tick(ms, get().playing);
      },
      onPlayingChange: (playing) => {
        set({ playing, ...(playing ? { ended: false } : {}) });
        tracker.tick(engine?.positionMs() ?? 0, playing);
        setPlaybackState(playing);
        syncPosition();
        saveSoon(playing ? 5000 : 500);
      },
      onBuffering: (buffering) => set({ buffering }),
      onAutoAdvance: (trackId) => {
        tracker.finish(false);
        errorStreak = 0;
        const r = Q.advance(get().queue, { auto: true });
        set({ queue: r.queue, positionMs: 0 });
        if (r.queue.current?.trackId !== trackId) return loadCurrent(true, 0); // out of sync: trust the queue
        afterTrackChange();
      },
      onEnded: () => {
        tracker.finish(false);
        const r = Q.advance(get().queue, { auto: true });
        if (r.ended) {
          wantPlay = false;
          set({ ended: true, playing: false, positionMs: 0 });
          pendingRestore = { startMs: 0 };
          setPlaybackState(false);
          return;
        }
        set({ queue: r.queue });
        loadCurrent(true, 0);
      },
      onError: (trackId, message) => {
        set({ error: `Couldn't play this track (${message}).`, buffering: false });
        // Skip forward, but don't spin through a whole broken queue.
        if (++errorStreak <= 3 && trackId === get().queue.current?.trackId)
          setTimeout(() => skip(true), 1500);
      },
    };
    engine = isAppleMobile()
      ? new ElementEngine(cb, { webAudio: useDeviceSettings.getState().iosAudioProcessing })
      : new DualEngine(cb);
    set({ engineKind: engine.kind });
    engine.setVolume(get().muted ? 0 : get().volume);
    applySettingsToEngine();
    return engine;
  };

  /** Load the queue's current entry into the engine. */
  function loadCurrent(autoplay: boolean, startMs: number): void {
    const cur = get().queue.current;
    pendingRestore = null;
    if (!cur) {
      engine?.pause();
      return;
    }
    wantPlay = autoplay;
    const t = engineTrack(cur.trackId);
    set({
      tier: adaptive.current(preferredTier(), settings?.autoAdjustQuality ?? true),
      positionMs: startMs,
      ended: false,
      error: null,
    });
    getEngine().load(t, { autoplay, startMs });
    afterTrackChange();
  }

  /** Everything that follows a change of the current track (manual or automatic). */
  function afterTrackChange(): void {
    const { queue } = get();
    const cur = queue.current;
    if (!cur) return;
    const cache = useTrackCache.getState();
    tracker.start(cur.trackId, cache.byId[cur.trackId]?.durationMs ?? 0, queue.context);
    const ids = [
      cur.trackId,
      ...Q.upcoming(queue)
        .slice(0, 20)
        .map((e) => e.trackId),
    ];
    void cache.ensure(ids).then(() => {
      const meta = useTrackCache.getState().byId[cur.trackId];
      if (get().queue.current?.uid !== cur.uid) return;
      setNowPlaying(meta);
      if (meta) {
        tracker.setDuration(cur.trackId, meta.durationMs);
        engine?.updateTrack(cur.trackId, {
          durationMs: meta.durationMs,
          gainDb: gainFor(cur.trackId),
          albumId: meta.album.id,
        });
      }
      syncPosition();
    });
    setNowPlaying(cache.byId[cur.trackId]);
    prepareNext();
    if (settings?.autoAdjustQuality ?? true) void adaptive.probe(cur.trackId);
    saveSoon(500);
  }

  /** Hand the engine the next track (gapless/crossfade) and ask the server to transcode it now. */
  function prepareNext(): void {
    if (!engine) return;
    const n = Q.peekNext(get().queue);
    if (!n) return engine.setNext(null);
    const t = engineTrack(n.trackId);
    engine.setNext(t);
    const qs = t.url.split('?')[1] ?? '';
    void api(`/stream/${n.trackId}/prepare?${qs}`, { method: 'POST' }).catch(() => undefined);
    void useTrackCache
      .getState()
      .ensure([n.trackId])
      .then(() => {
        const meta = useTrackCache.getState().byId[n.trackId];
        if (meta)
          engine?.updateTrack(n.trackId, {
            durationMs: meta.durationMs,
            gainDb: gainFor(n.trackId),
            albumId: meta.album.id,
          });
      });
  }

  /** Manual "next". Keeps the play/pause state unless `autoplay` says otherwise. */
  function skip(autoplay: boolean): void {
    if (!get().queue.current) return;
    getEngine().unlock();
    tracker.finish(true);
    const r = Q.advance(get().queue, { auto: false });
    if (r.ended) {
      engine?.pause();
      wantPlay = false;
      set({ ended: true, positionMs: 0 });
      pendingRestore = { startMs: 0 };
      return;
    }
    set({ queue: r.queue });
    loadCurrent(autoplay, 0);
  }

  function syncPosition(): void {
    const cur = get().queue.current;
    const meta = cur ? useTrackCache.getState().byId[cur.trackId] : undefined;
    if (meta) setPosition(engine?.positionMs() ?? get().positionMs, meta.durationMs);
  }

  function updateQueue(queue: Q.QueueState, { reloadNext = true } = {}): void {
    set({ queue });
    if (reloadNext) prepareNext();
    saveSoon(1000);
  }

  installMediaSession({
    play: () => get().play(),
    pause: () => get().pause(),
    next: () => get().next(),
    previous: () => get().previous(),
    seekTo: (ms) => get().seek(ms),
  });

  return {
    queue: Q.emptyQueue(),
    playing: false,
    buffering: false,
    positionMs: 0,
    volume: 0.8,
    muted: false,
    ended: false,
    error: null,
    tier: null,
    engineKind: null,

    unlockAudio() {
      getEngine().unlock();
    },

    playContext(context, trackIds, startIndex, opts) {
      getEngine().unlock(); // synchronously, inside the tap
      if (get().queue.current) tracker.finish(true);
      errorStreak = 0;
      set({ queue: Q.playContext(get().queue, context, trackIds, startIndex, opts) });
      loadCurrent(true, 0);
    },

    togglePlay() {
      if (get().playing) get().pause();
      else get().play();
    },

    play() {
      const e = getEngine();
      e.unlock();
      if (!get().queue.current) return;
      wantPlay = true;
      if (pendingRestore) return loadCurrent(true, pendingRestore.startMs);
      void e.play();
    },

    pause() {
      wantPlay = false;
      engine?.pause();
    },

    next() {
      skip(wantPlay);
    },

    previous() {
      getEngine().unlock();
      if (get().positionMs > 3000) return get().seek(0);
      const b = Q.back(get().queue);
      if (!b) return get().seek(0);
      tracker.finish(true);
      set({ queue: b });
      loadCurrent(wantPlay, 0);
    },

    seek(ms) {
      const cur = get().queue.current;
      if (!cur) return;
      const dur = useTrackCache.getState().byId[cur.trackId]?.durationMs;
      const target = Math.max(0, dur ? Math.min(ms, dur - 250) : ms);
      set({ positionMs: target });
      if (pendingRestore) pendingRestore = { startMs: target };
      else engine?.seek(target);
      syncPosition();
      saveSoon(1000);
    },

    seekBy(delta) {
      get().seek(get().positionMs + delta);
    },

    setVolume(v) {
      const volume = Math.max(0, Math.min(1, v));
      set({ volume, muted: false });
      engine?.setVolume(volume);
      saveSoon(1000);
    },

    toggleMute() {
      const muted = !get().muted;
      set({ muted });
      engine?.setVolume(muted ? 0 : get().volume);
    },

    toggleShuffle() {
      updateQueue(Q.setShuffle(get().queue, !get().queue.shuffle));
    },

    cycleRepeat() {
      updateQueue(Q.cycleRepeat(get().queue));
    },

    playNext(ids) {
      updateQueue(Q.playNext(get().queue, ids));
    },

    addToQueue(ids) {
      updateQueue(Q.addToQueue(get().queue, ids));
    },

    removeFromQueue(uid) {
      updateQueue(Q.removeUpcoming(get().queue, uid));
    },

    clearQueue() {
      updateQueue(Q.clearUpNext(get().queue));
    },

    moveInQueue(fromUid, overUid) {
      updateQueue(Q.moveUpcoming(get().queue, fromUid, overUid));
    },

    jumpTo(uid) {
      getEngine().unlock();
      tracker.finish(true);
      set({ queue: Q.jumpTo(get().queue, uid) });
      loadCurrent(true, 0);
    },

    dismissError() {
      set({ error: null });
    },
  };
});

// ───────────────────────────── settings ─────────────────────────────

function applySettingsToEngine(): void {
  if (!engine || !settings) return;
  engine.setProcessing({
    eqBands: settings.eqEnabled ? settings.eqBands : null,
    crossfadeSec: settings.crossfadeSeconds,
  });
}

/** Called whenever account settings load or change. */
export function configurePlayer(next: UserSettingsDto): void {
  settings = next;
  applySettingsToEngine();
  // Re-apply ReplayGain to whatever is loaded.
  const { queue } = usePlayer.getState();
  for (const e of [queue.current, Q.peekNext(queue)]) {
    if (e) engine?.updateTrack(e.trackId, { gainDb: gainFor(e.trackId) });
  }
}

// ───────────────────────────── persistence ─────────────────────────────

let serverVersion: number | undefined;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastServerSave = 0;

function snapshot(): SavePlayerState {
  const s = usePlayer.getState();
  return {
    queue: s.queue,
    positionMs: Math.round(engine?.positionMs() ?? s.positionMs),
    isPlaying: s.playing,
    volume: s.volume,
    deviceId: DEVICE_ID,
  };
}

/** Local copy right away (cheap, survives reloads); server copy at most every few seconds. */
function saveSoon(delayMs: number): void {
  if (userKey === 'anon') return;
  storage.set(LOCAL_KEY(), snapshot());
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(
    () => void saveToServer(),
    Math.max(delayMs, 3000 - (Date.now() - lastServerSave)),
  );
}

async function saveToServer(keepalive = false): Promise<void> {
  saveTimer = null;
  if (userKey === 'anon' || !usePlayer.getState().queue.current) return;
  lastServerSave = Date.now();
  const body = {
    ...snapshot(),
    ...(serverVersion !== undefined ? { version: serverVersion } : {}),
  };
  try {
    const res = await api<{ version: number }>('/me/player', {
      method: 'PUT',
      body,
      keepalive: keepalive && JSON.stringify(body).length < 60_000,
    });
    serverVersion = res.version;
  } catch (err) {
    // Another device saved meanwhile. This device is the one being used, so take over.
    if (err instanceof ApiError && err.code === 'STALE_PLAYER_STATE') {
      const current = (err.details as { current?: PlayerStateDto } | undefined)?.current;
      serverVersion = current?.version;
      if (serverVersion !== undefined) void saveToServer();
    }
  }
}

/** Restore the last session for this user (local copy first, else the server's). Doesn't start playback. */
export async function restorePlayer(userId: string): Promise<void> {
  userKey = userId;
  const local = storage.get<SavePlayerState>(LOCAL_KEY());
  let state: Pick<SavePlayerState, 'queue' | 'positionMs' | 'volume'> | null = local;
  try {
    const remote = await api<PlayerStateDto | null>('/me/player');
    serverVersion = remote?.version;
    if (!state && remote) state = remote;
  } catch {
    // Offline: the local copy is all we have.
  }
  if (!state?.queue.current) return;
  usePlayer.setState({
    queue: state.queue,
    positionMs: state.positionMs,
    volume: state.volume,
    playing: false,
  });
  pendingRestore = { startMs: state.positionMs };
  const ids = [
    state.queue.current.trackId,
    ...Q.upcoming(state.queue)
      .slice(0, 20)
      .map((e) => e.trackId),
  ];
  await useTrackCache
    .getState()
    .ensure(ids)
    .catch(() => undefined);
  setNowPlaying(useTrackCache.getState().byId[state.queue.current.trackId]);
  setPlaybackState(false);
}

/** Flush state when the page is being hidden/closed (iOS kills background tabs without warning). */
export function installLifecycleHooks(): void {
  const flush = () => {
    if (userKey === 'anon') return;
    storage.set(LOCAL_KEY(), snapshot());
    void saveToServer(true);
    void tracker.flush();
  };
  document.addEventListener(
    'visibilitychange',
    () => document.visibilityState === 'hidden' && flush(),
  );
  window.addEventListener('pagehide', flush);
  window.addEventListener('online', () => void tracker.flush());
  setInterval(() => void tracker.flush(), 60_000);
}

/** Sign-out: stop audio and forget the in-memory queue (the saved copies stay for next time). */
export function resetPlayer(): void {
  engine?.pause();
  pendingRestore = null;
  userKey = 'anon';
  usePlayer.setState({
    queue: Q.emptyQueue(),
    playing: false,
    positionMs: 0,
    ended: false,
    error: null,
  });
  setNowPlaying(undefined);
  setPlaybackState(null);
}

/** Exposed for tests and debugging. */
export const __internals = { adaptive, tracker };

declare global {
  interface Window {
    /** Debugging/E2E handle: read the player state from the console. */
    __tidepool?: { player: () => PlayerStore; positionMs: () => number };
  }
}
if (typeof window !== 'undefined') {
  window.__tidepool = {
    player: () => usePlayer.getState(),
    positionMs: () => engine?.positionMs() ?? 0,
  };
}

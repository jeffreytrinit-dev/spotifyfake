import { dbToGain } from '../sound.js';
import type { AudioGraph, DeckNodes } from './graph.js';
import type { EngineTrack } from './types.js';

export type DeckEvent = 'time' | 'playing' | 'pause' | 'waiting' | 'canplay' | 'ended' | 'error';

/**
 * One <audio> element plus the logic both engines share: deferred seeking until metadata is
 * known, and switching to the "wait for transcode" URL when asked to seek inside a live stream
 * (which can't seek).
 */
export class Deck {
  readonly audio: HTMLAudioElement;
  track: EngineTrack | null = null;
  nodes: DeckNodes | null = null;
  private pendingSeekMs: number | null = null;
  private onWaitUrl = false;

  constructor(private readonly emit: (deck: Deck, event: DeckEvent) => void) {
    const a = document.createElement('audio');
    a.preload = 'auto';
    a.setAttribute('playsinline', '');
    a.setAttribute('aria-hidden', 'true');
    this.audio = a;
    a.addEventListener('timeupdate', () => emit(this, 'time'));
    a.addEventListener('playing', () => emit(this, 'playing'));
    a.addEventListener('pause', () => emit(this, 'pause'));
    a.addEventListener('waiting', () => emit(this, 'waiting'));
    a.addEventListener('canplay', () => emit(this, 'canplay'));
    a.addEventListener('ended', () => emit(this, 'ended'));
    a.addEventListener('error', () => {
      if (a.getAttribute('src')) emit(this, 'error');
    });
    a.addEventListener('loadedmetadata', () => {
      if (this.pendingSeekMs !== null) {
        const ms = this.pendingSeekMs;
        this.pendingSeekMs = null;
        this.seek(ms);
      }
    });
  }

  attach(graph: AudioGraph): void {
    if (!this.nodes) {
      this.nodes = graph.connectElement(this.audio);
      this.applyGain();
    }
  }

  load(track: EngineTrack, startMs = 0): void {
    this.track = track;
    this.onWaitUrl = false;
    this.pendingSeekMs = startMs > 0 ? startMs : null;
    this.audio.src = track.url;
    this.audio.load();
    this.applyGain();
  }

  unload(): void {
    this.track = null;
    this.pendingSeekMs = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  private seekableAt(sec: number): boolean {
    const r = this.audio.seekable;
    for (let i = 0; i < r.length; i++) if (sec >= r.start(i) && sec <= r.end(i)) return true;
    return false;
  }

  /** Returns true if the stream had to be reloaded to make the position reachable. */
  seek(ms: number): boolean {
    if (!this.track) return false;
    const sec = ms / 1000;
    if (this.audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      this.pendingSeekMs = ms;
      return false;
    }
    if (this.seekableAt(sec) || this.onWaitUrl) {
      this.audio.currentTime = sec;
      return false;
    }
    // Live transcode: reload as a seekable file once the server finishes it.
    const wasPlaying = !this.audio.paused;
    this.onWaitUrl = true;
    this.pendingSeekMs = ms;
    this.audio.src = this.track.waitUrl;
    this.audio.load();
    if (wasPlaying) void this.audio.play().catch(() => undefined);
    return true;
  }

  applyGain(): void {
    if (this.nodes && this.track) this.nodes.trackGain.gain.value = dbToGain(this.track.gainDb);
  }

  positionMs(): number {
    if (this.pendingSeekMs !== null) return this.pendingSeekMs;
    return this.audio.currentTime * 1000;
  }

  /** Seconds; falls back to library metadata when the stream is live (duration = Infinity). */
  durationSec(): number {
    const d = this.audio.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return (this.track?.durationMs ?? 0) / 1000;
  }
}

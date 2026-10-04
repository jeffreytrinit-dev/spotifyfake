import { equalPowerCurves, shouldCrossfade } from '../sound.js';
import { Deck, type DeckEvent } from './deck.js';
import { AudioGraph } from './graph.js';
import {
  volumeCurve,
  type EngineCallbacks,
  type EngineTrack,
  type PlaybackEngine,
  type ProcessingSettings,
} from './types.js';

/** Start the next deck this long before the current one ends (covers play() start-up latency). */
const GAPLESS_LEAD_SEC = 0.04;
const CURVES = equalPowerCurves(128);

/**
 * Two <audio> decks through Web Audio (desktop browsers). While one plays, the next track is
 * already buffered on the other deck; near the end the second deck is started on a timer so
 * there's (almost) no gap, or faded in with an equal-power crossfade. Element-based playback
 * can't be sample-accurate, so "gapless" here means within a few milliseconds.
 */
export class DualEngine implements PlaybackEngine {
  readonly kind = 'dual' as const;
  readonly canProcess = true;
  private readonly decks: [Deck, Deck];
  private active = 0;
  private graph: AudioGraph | null = null;
  private next: EngineTrack | null = null;
  private crossfadeSec = 0;
  private eq: readonly number[] | null = null;
  private volume = 1;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeCleanup: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cb: EngineCallbacks) {
    this.decks = [new Deck((d, e) => this.onDeck(d, e)), new Deck((d, e) => this.onDeck(d, e))];
  }

  private get cur(): Deck {
    return this.decks[this.active]!;
  }
  private get other(): Deck {
    return this.decks[1 - this.active]!;
  }

  private ensureGraph(): AudioGraph {
    if (!this.graph) {
      this.graph = new AudioGraph();
      for (const d of this.decks) d.attach(this.graph);
      this.graph.setVolume(volumeCurve(this.volume));
      this.graph.setEq(this.eq);
    }
    return this.graph;
  }

  private onDeck(deck: Deck, e: DeckEvent): void {
    if (deck !== this.cur) {
      // The outgoing deck finishing after a transition is expected; nothing else matters.
      return;
    }
    switch (e) {
      case 'time':
        this.cb.onTime(deck.positionMs());
        return this.scheduleTransition();
      case 'playing':
        this.cb.onBuffering(false);
        this.startMonitor();
        return this.cb.onPlayingChange(true);
      case 'pause':
        this.stopMonitor();
        return this.cb.onPlayingChange(false);
      case 'waiting':
        return this.cb.onBuffering(true);
      case 'canplay':
        return this.cb.onBuffering(false);
      case 'error':
        return this.cb.onError(
          deck.track?.trackId ?? null,
          deck.audio.error?.message || 'Playback error',
        );
      case 'ended':
        if (this.next) return this.transition(0);
        this.stopMonitor();
        return this.cb.onEnded();
    }
  }

  private startMonitor(): void {
    this.monitor ??= setInterval(() => this.scheduleTransition(), 100);
  }
  private stopMonitor(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
  }
  private cancelTransition(): void {
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
  }

  /** Arm a precise timer once we're within a second of the switch point. */
  private scheduleTransition(): void {
    if (!this.next || this.transitionTimer || this.cur.audio.paused) return;
    const duration = this.cur.durationSec();
    if (!duration) return;
    const remaining = duration - this.cur.audio.currentTime;
    const fade = shouldCrossfade(this.crossfadeSec, this.cur.track, this.next)
      ? Math.min(this.crossfadeSec, duration / 2)
      : 0;
    const lead = fade > 0 ? fade : GAPLESS_LEAD_SEC;
    if (remaining > lead + 1) return;
    this.transitionTimer = setTimeout(
      () => {
        this.transitionTimer = null;
        this.transition(fade);
      },
      Math.max(0, (remaining - lead) * 1000),
    );
  }

  private transition(fadeSec: number): void {
    const next = this.next;
    if (!next) return;
    this.cancelTransition();
    const graph = this.ensureGraph();
    const outgoing = this.cur;
    const incoming = this.other;
    if (incoming.track?.trackId !== next.trackId) incoming.load(next);
    this.next = null;
    this.active = 1 - this.active;

    const now = graph.ctx.currentTime;
    const inFade = incoming.nodes!.fade.gain;
    const outFade = outgoing.nodes!.fade.gain;
    inFade.cancelScheduledValues(now);
    outFade.cancelScheduledValues(now);
    if (fadeSec > 0) {
      inFade.setValueCurveAtTime(CURVES.fadeIn, now, fadeSec);
      outFade.setValueCurveAtTime(CURVES.fadeOut, now, fadeSec);
    } else {
      inFade.setValueAtTime(1, now);
    }
    void incoming.audio.play().catch((err: unknown) => this.cb.onError(next.trackId, String(err)));
    if (this.fadeCleanup) clearTimeout(this.fadeCleanup);
    this.fadeCleanup = setTimeout(
      () => {
        outgoing.audio.pause();
        outgoing.unload();
        outFade.setValueAtTime(1, graph.ctx.currentTime);
      },
      fadeSec * 1000 + 300,
    );
    this.cb.onAutoAdvance(next.trackId);
  }

  unlock(): void {
    void this.ensureGraph().resume();
  }

  load(track: EngineTrack, { autoplay, startMs }: { autoplay: boolean; startMs: number }): void {
    this.cancelTransition();
    if (this.fadeCleanup) clearTimeout(this.fadeCleanup);
    for (const d of this.decks) if (d !== this.cur) d.unload();
    if (this.graph) this.cur.nodes!.fade.gain.setValueAtTime(1, this.graph.ctx.currentTime);
    this.cur.load(track, startMs);
    if (this.next) this.other.load(this.next);
    if (autoplay) void this.play();
  }

  setNext(track: EngineTrack | null): void {
    this.cancelTransition();
    this.next = track;
    if (!track) this.other.unload();
    else if (this.other.track?.trackId !== track.trackId) this.other.load(track);
  }

  async play(): Promise<void> {
    const graph = this.ensureGraph();
    await graph.resume();
    try {
      await this.cur.audio.play();
    } catch (err) {
      if ((err as DOMException)?.name === 'NotAllowedError') this.cb.onPlayingChange(false);
      else if ((err as DOMException)?.name !== 'AbortError')
        this.cb.onError(this.cur.track?.trackId ?? null, String(err));
    }
  }

  pause(): void {
    this.cancelTransition();
    for (const d of this.decks) d.audio.pause();
  }

  seek(ms: number): void {
    this.cancelTransition();
    if (this.cur.seek(ms)) this.cb.onBuffering(true);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.graph?.setVolume(volumeCurve(volume));
  }

  setProcessing(p: ProcessingSettings): void {
    this.eq = p.eqBands;
    this.crossfadeSec = p.crossfadeSec;
    this.graph?.setEq(p.eqBands);
  }

  updateTrack(
    trackId: string,
    info: Partial<Pick<EngineTrack, 'durationMs' | 'gainDb' | 'albumId'>>,
  ): void {
    for (const d of this.decks) {
      if (d.track?.trackId === trackId) {
        Object.assign(d.track, info);
        d.applyGain();
      }
    }
    if (this.next?.trackId === trackId) Object.assign(this.next, info);
  }

  positionMs(): number {
    return this.cur.positionMs();
  }

  isPlaying(): boolean {
    return !this.cur.audio.paused;
  }

  destroy(): void {
    this.stopMonitor();
    this.cancelTransition();
    for (const d of this.decks) d.unload();
    this.graph?.close();
  }
}

import { Deck, type DeckEvent } from './deck.js';
import { AudioGraph } from './graph.js';
import {
  volumeCurve,
  type EngineCallbacks,
  type EngineTrack,
  type PlaybackEngine,
  type ProcessingSettings,
} from './types.js';

/** 0.1 s of silent 8 kHz mono PCM WAV. */
const SILENCE = (() => {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit PCM silence is the midpoint
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
})();

/**
 * One <audio> element. Used on iPhone/iPad, where it is the only reliable way to keep playing
 * with the screen locked: when a track ends, the next URL (prepared in advance) is set and
 * played synchronously inside the `ended` handler, with no awaits in between.
 *
 * Web Audio (EQ, ReplayGain) is opt-in here because iOS may suspend the AudioContext in the
 * background, which would silence everything routed through it.
 */
export class ElementEngine implements PlaybackEngine {
  readonly kind = 'element' as const;
  private readonly deck: Deck;
  private graph: AudioGraph | null = null;
  private next: EngineTrack | null = null;
  private volume = 1;
  private eq: readonly number[] | null = null;
  private unlocked = false;

  constructor(
    private readonly cb: EngineCallbacks,
    private readonly opts: { webAudio: boolean },
  ) {
    this.deck = new Deck((d, e) => this.onDeck(e));
  }

  get canProcess(): boolean {
    return this.opts.webAudio;
  }

  private onDeck(e: DeckEvent): void {
    const a = this.deck.audio;
    switch (e) {
      case 'time':
        return this.cb.onTime(this.deck.positionMs());
      case 'playing':
        this.cb.onBuffering(false);
        return this.cb.onPlayingChange(true);
      case 'pause':
        return this.cb.onPlayingChange(false);
      case 'waiting':
        return this.cb.onBuffering(true);
      case 'canplay':
        return this.cb.onBuffering(false);
      case 'error':
        return this.cb.onError(
          this.deck.track?.trackId ?? null,
          a.error?.message || 'Playback error',
        );
      case 'ended': {
        const n = this.next;
        if (!n) return this.cb.onEnded();
        this.next = null;
        this.deck.load(n);
        // Synchronous play() in the ended handler keeps iOS playing in the background.
        void a.play().catch((err: unknown) => this.cb.onError(n.trackId, String(err)));
        this.cb.onAutoAdvance(n.trackId);
        return;
      }
    }
  }

  private ensureGraph(): void {
    if (!this.opts.webAudio || this.graph) return;
    this.graph = new AudioGraph();
    this.deck.attach(this.graph);
    this.graph.setVolume(volumeCurve(this.volume));
    this.graph.setEq(this.eq);
    this.deck.audio.volume = 1;
  }

  /**
   * iOS only lets an <audio> element play after it has played inside a user gesture. If nothing
   * is loaded yet (e.g. the tap first has to fetch the album), play a moment of silence now so
   * the real play() after the fetch is allowed.
   */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.ensureGraph();
    void this.graph?.resume();
    const a = this.deck.audio;
    if (!a.getAttribute('src')) {
      a.src = SILENCE;
      void a.play().catch(() => undefined);
    }
  }

  load(track: EngineTrack, { autoplay, startMs }: { autoplay: boolean; startMs: number }): void {
    this.deck.load(track, startMs);
    if (autoplay) void this.play();
  }

  setNext(track: EngineTrack | null): void {
    this.next = track;
  }

  async play(): Promise<void> {
    this.ensureGraph();
    const playing = this.deck.audio.play();
    if (this.graph) void this.graph.resume();
    try {
      await playing;
    } catch (err) {
      // NotAllowedError: needs a tap first. Report as paused rather than an error.
      if ((err as DOMException)?.name === 'NotAllowedError') this.cb.onPlayingChange(false);
      else if ((err as DOMException)?.name !== 'AbortError')
        this.cb.onError(this.deck.track?.trackId ?? null, String(err));
    }
  }

  pause(): void {
    this.deck.audio.pause();
  }

  seek(ms: number): void {
    if (this.deck.seek(ms)) this.cb.onBuffering(true);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.graph) this.graph.setVolume(volumeCurve(volume));
    else this.deck.audio.volume = volumeCurve(volume); // ignored by iOS (hardware buttons rule)
  }

  setProcessing(p: ProcessingSettings): void {
    this.eq = p.eqBands;
    this.graph?.setEq(p.eqBands);
  }

  updateTrack(
    trackId: string,
    info: Partial<Pick<EngineTrack, 'durationMs' | 'gainDb' | 'albumId'>>,
  ): void {
    if (this.deck.track?.trackId === trackId) {
      Object.assign(this.deck.track, info);
      this.deck.applyGain();
    }
    if (this.next?.trackId === trackId) Object.assign(this.next, info);
  }

  positionMs(): number {
    return this.deck.positionMs();
  }

  isPlaying(): boolean {
    return !this.deck.audio.paused;
  }

  destroy(): void {
    this.deck.unload();
    this.graph?.close();
  }
}

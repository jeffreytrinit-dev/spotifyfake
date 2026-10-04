import { dbToGain, EQ_FREQUENCIES, eqFilterType, eqPreampDb } from '../sound.js';

export interface DeckNodes {
  source: MediaElementAudioSourceNode;
  /** ReplayGain. */
  trackGain: GainNode;
  /** Crossfade envelope. */
  fade: GainNode;
}

/**
 * The shared Web Audio graph:  deck(s) → [trackGain → fade] → preamp → 10× EQ → master → out.
 * Created lazily, because browsers only let an AudioContext run after a user gesture.
 */
export class AudioGraph {
  readonly ctx: AudioContext;
  private readonly preamp: GainNode;
  private readonly filters: BiquadFilterNode[];
  private readonly master: GainNode;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.preamp = this.ctx.createGain();
    this.master = this.ctx.createGain();
    this.filters = EQ_FREQUENCIES.map((freq, i) => {
      const f = this.ctx.createBiquadFilter();
      f.type = eqFilterType(i);
      f.frequency.value = freq;
      f.Q.value = 1.1;
      f.gain.value = 0;
      return f;
    });
    let node: AudioNode = this.preamp;
    for (const f of this.filters) {
      node.connect(f);
      node = f;
    }
    node.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  connectElement(el: HTMLMediaElement): DeckNodes {
    const source = this.ctx.createMediaElementSource(el);
    const trackGain = this.ctx.createGain();
    const fade = this.ctx.createGain();
    source.connect(trackGain).connect(fade).connect(this.preamp);
    return { source, trackGain, fade };
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
  }

  setVolume(linear: number): void {
    this.master.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.015);
  }

  setEq(bands: readonly number[] | null): void {
    const now = this.ctx.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(bands?.[i] ?? 0, now, 0.03));
    this.preamp.gain.setTargetAtTime(dbToGain(bands ? eqPreampDb(bands) : 0), now, 0.03);
  }

  close(): void {
    void this.ctx.close().catch(() => undefined);
  }
}

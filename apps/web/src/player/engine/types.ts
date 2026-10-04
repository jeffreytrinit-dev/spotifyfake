export interface EngineTrack {
  trackId: string;
  /** Stream URL (may be a live, non-seekable transcode on first play). */
  url: string;
  /** Same stream, but the server waits for the transcode so the response is seekable. */
  waitUrl: string;
  /** From library metadata; 0 until known. Used because live streams report Infinity. */
  durationMs: number;
  /** ReplayGain to apply, in dB. */
  gainDb: number;
  albumId: string | null;
}

export interface EngineCallbacks {
  onTime(positionMs: number): void;
  onPlayingChange(playing: boolean): void;
  onBuffering(buffering: boolean): void;
  /** The engine moved to the preloaded next track by itself (gapless/crossfade/ended). */
  onAutoAdvance(trackId: string): void;
  /** The current track ended and nothing was queued up. */
  onEnded(): void;
  onError(trackId: string | null, message: string): void;
}

export interface ProcessingSettings {
  /** 10 band gains in dB, or null for no EQ. */
  eqBands: readonly number[] | null;
  crossfadeSec: number;
}

export interface PlaybackEngine {
  readonly kind: 'element' | 'dual';
  /** True when EQ/ReplayGain can actually be applied on this engine. */
  readonly canProcess: boolean;
  load(track: EngineTrack, opts: { autoplay: boolean; startMs: number }): void;
  setNext(track: EngineTrack | null): void;
  play(): Promise<void>;
  pause(): void;
  seek(ms: number): void;
  setVolume(volume: number): void;
  setProcessing(p: ProcessingSettings): void;
  /** Metadata arrived (or settings changed) for a loaded/preloaded track. */
  updateTrack(
    trackId: string,
    info: Partial<Pick<EngineTrack, 'durationMs' | 'gainDb' | 'albumId'>>,
  ): void;
  /** Call synchronously inside a user gesture before any async work (iOS media unlock). */
  unlock(): void;
  positionMs(): number;
  isPlaying(): boolean;
  destroy(): void;
}

/** Perceived loudness is roughly logarithmic; squaring the slider value feels linear. */
export const volumeCurve = (v: number): number => Math.max(0, Math.min(1, v)) ** 2;

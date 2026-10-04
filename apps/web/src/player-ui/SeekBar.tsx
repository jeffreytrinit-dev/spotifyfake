import { useState } from 'react';
import { Range } from '../components/Range.js';
import { formatTime } from '../lib/format.js';
import { usePlayer } from '../player/store.js';
import { useCurrentTrack } from './hooks.js';

/** Seek bar that only seeks on release, so dragging doesn't hammer the stream. */
export function SeekBar({ className = '' }: { className?: string }) {
  const position = usePlayer((s) => s.positionMs);
  const seek = usePlayer((s) => s.seek);
  const track = useCurrentTrack();
  const [drag, setDrag] = useState<number | null>(null);
  const duration = track?.durationMs ?? 0;
  const shown = drag ?? Math.min(position, duration || position);
  return (
    <div className={`flex items-center gap-3 text-xs tabular-nums text-muted ${className}`}>
      <span className="w-10 text-right">{formatTime(shown)}</span>
      <Range
        label="Seek"
        min={0}
        max={Math.max(duration, 1)}
        step={1000}
        value={shown}
        valueText={`${formatTime(shown)} of ${formatTime(duration)}`}
        disabled={!duration}
        onChange={setDrag}
        onCommit={(v) => {
          seek(v);
          setDrag(null);
        }}
      />
      <span className="w-10">{formatTime(duration)}</span>
    </div>
  );
}

/** The thin progress line on the mobile mini player. */
export function ProgressLine() {
  const position = usePlayer((s) => s.positionMs);
  const track = useCurrentTrack();
  const pct = track?.durationMs ? Math.min(100, (position / track.durationMs) * 100) : 0;
  return (
    <div aria-hidden className="h-0.5 w-full bg-line">
      <div
        className="h-full bg-fg transition-[width] duration-300 ease-linear"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

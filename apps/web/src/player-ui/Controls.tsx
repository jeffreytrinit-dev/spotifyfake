import {
  Loader2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { IconButton } from '../components/IconButton.js';
import { usePlayer } from '../player/store.js';

export function PlayPauseButton({
  size = 'lg',
  variant = 'solid',
}: {
  size?: 'md' | 'lg';
  variant?: 'solid' | 'plain';
}) {
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const hasTrack = usePlayer((s) => !!s.queue.current);
  const toggle = usePlayer((s) => s.togglePlay);
  const icon =
    buffering && playing ? (
      <Loader2 className="animate-spin" />
    ) : playing ? (
      <Pause fill="currentColor" />
    ) : (
      <Play fill="currentColor" className="translate-x-px" />
    );
  return (
    <IconButton
      label={playing ? 'Pause' : 'Play'}
      size={size}
      disabled={!hasTrack}
      onClick={toggle}
      className={variant === 'solid' ? 'bg-fg !text-bg hover:bg-fg hover:brightness-90' : ''}
    >
      {icon}
    </IconButton>
  );
}

export function TransportControls({ compact = false }: { compact?: boolean }) {
  const shuffle = usePlayer((s) => s.queue.shuffle);
  const repeat = usePlayer((s) => s.queue.repeat);
  const hasTrack = usePlayer((s) => !!s.queue.current);
  const { previous, next, toggleShuffle, cycleRepeat } = usePlayer.getState();
  const repeatLabel = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one track' }[repeat];
  return (
    <div className={`flex items-center justify-center ${compact ? 'gap-2' : 'gap-4 sm:gap-6'}`}>
      <IconButton
        label={shuffle ? 'Shuffle: on' : 'Shuffle: off'}
        active={shuffle}
        onClick={toggleShuffle}
        disabled={!hasTrack}
      >
        <Shuffle size={20} />
      </IconButton>
      <IconButton label="Previous" onClick={previous} disabled={!hasTrack}>
        <SkipBack size={24} fill="currentColor" />
      </IconButton>
      <PlayPauseButton size={compact ? 'md' : 'lg'} />
      <IconButton label="Next" onClick={next} disabled={!hasTrack}>
        <SkipForward size={24} fill="currentColor" />
      </IconButton>
      <IconButton
        label={repeatLabel}
        active={repeat !== 'off'}
        onClick={cycleRepeat}
        disabled={!hasTrack}
      >
        {repeat === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
      </IconButton>
    </div>
  );
}

import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { IconButton } from '../components/IconButton.js';
import { Range } from '../components/Range.js';
import { isAppleMobile } from '../player/platform.js';
import { usePlayer } from '../player/store.js';

/** Hidden on iPhone, where the hardware buttons control volume and web pages can't. */
export function VolumeControl({ className = '' }: { className?: string }) {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const { setVolume, toggleMute } = usePlayer.getState();
  if (isAppleMobile()) return null;
  const v = muted ? 0 : volume;
  const Icon = v === 0 ? VolumeX : v < 0.5 ? Volume1 : Volume2;
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <IconButton label={muted ? 'Unmute' : 'Mute'} size="sm" onClick={toggleMute}>
        <Icon size={18} />
      </IconButton>
      <Range
        label="Volume"
        min={0}
        max={100}
        value={Math.round(v * 100)}
        valueText={`${Math.round(v * 100)}%`}
        onChange={(x) => setVolume(x / 100)}
        className="w-24"
      />
    </div>
  );
}

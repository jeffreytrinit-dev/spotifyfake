import { ListMusic, Maximize2 } from 'lucide-react';
import { Link } from 'react-router';
import { useUi } from '../app/ui-store.js';
import { Artwork } from '../components/Artwork.js';
import { IconButton } from '../components/IconButton.js';
import { TIER_LABEL } from '../lib/format.js';
import { usePlayer } from '../player/store.js';
import { PlayPauseButton, TransportControls } from './Controls.js';
import { useCurrentTrack } from './hooks.js';
import { ProgressLine, SeekBar } from './SeekBar.js';
import { VolumeControl } from './Volume.js';

/**
 * Always-visible player. Phone: a compact card above the tab bar (tap to open Now Playing).
 * Desktop: full-width bar with transport, seek and volume.
 */
export function PlayerBar() {
  const track = useCurrentTrack();
  const hasTrack = usePlayer((s) => !!s.queue.current);
  const tier = usePlayer((s) => s.tier);
  const openNowPlaying = useUi((s) => s.setNowPlaying);
  if (!hasTrack) return null;

  const info = (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold">{track?.title ?? 'Loading…'}</p>
      <p className="truncate text-xs text-muted">{track?.artistDisplay ?? ''}</p>
    </div>
  );

  return (
    <section aria-label="Player" className="border-t border-line bg-surface/95 backdrop-blur">
      {/* Phone */}
      <div className="md:hidden">
        <div className="flex items-center gap-3 px-3 py-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => openNowPlaying(true)}
            aria-label="Open now playing"
          >
            <Artwork
              artworkId={track?.artworkId}
              size={64}
              alt=""
              className="h-11 w-11"
              rounded="rounded-md"
            />
            {info}
          </button>
          <PlayPauseButton size="md" variant="plain" />
        </div>
        <ProgressLine />
      </div>

      {/* Desktop */}
      <div className="hidden grid-cols-[1fr_2fr_1fr] items-center gap-4 px-4 py-3 md:grid">
        <div className="flex min-w-0 items-center gap-3">
          <Artwork
            artworkId={track?.artworkId}
            size={64}
            alt=""
            className="h-14 w-14"
            rounded="rounded-md"
          />
          {track ? (
            <div className="min-w-0">
              <Link
                to={`/album/${track.album.id}`}
                className="block truncate text-sm font-semibold hover:underline"
              >
                {track.title}
              </Link>
              <p className="truncate text-xs text-muted">{track.artistDisplay}</p>
            </div>
          ) : (
            info
          )}
        </div>
        <div className="flex flex-col items-center gap-1">
          <TransportControls compact />
          <SeekBar className="w-full max-w-xl" />
        </div>
        <div className="flex items-center justify-end gap-1">
          {tier && (
            <span className="mr-2 rounded-md border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
              {TIER_LABEL[tier]}
            </span>
          )}
          <Link
            to="/queue"
            aria-label="Queue"
            title="Queue (Q)"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-surface-2"
          >
            <ListMusic size={18} />
          </Link>
          <VolumeControl />
          <IconButton label="Full-screen player (F)" size="sm" onClick={() => openNowPlaying(true)}>
            <Maximize2 size={16} />
          </IconButton>
        </div>
      </div>
    </section>
  );
}

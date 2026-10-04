import { ChevronDown, ListMusic } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useUi } from '../app/ui-store.js';
import { Artwork } from '../components/Artwork.js';
import { IconButton } from '../components/IconButton.js';
import { TIER_LABEL } from '../lib/format.js';
import { usePlayer } from '../player/store.js';
import { TransportControls } from './Controls.js';
import { useCurrentTrack } from './hooks.js';
import { SeekBar } from './SeekBar.js';
import { VolumeControl } from './Volume.js';

/** Full-screen player sheet. Escape or the chevron closes it; focus moves in and back out. */
export function NowPlaying() {
  const open = useUi((s) => s.nowPlayingOpen);
  const setOpen = useUi((s) => s.setNowPlaying);
  const track = useCurrentTrack();
  const context = usePlayer((s) => s.queue.context);
  const tier = usePlayer((s) => s.tier);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      className="fixed inset-0 z-40 flex flex-col bg-bg pt-safe pb-safe"
      style={{
        backgroundImage: `radial-gradient(120% 70% at 50% 0%, color-mix(in srgb, var(--tp-sea) 18%, transparent), transparent 70%)`,
      }}
    >
      <header className="flex items-center justify-between px-4 py-2">
        <IconButton ref={closeBtn} label="Close now playing" onClick={() => setOpen(false)}>
          <ChevronDown size={26} />
        </IconButton>
        <div className="min-w-0 text-center">
          <p className="text-[11px] uppercase tracking-widest text-muted">Playing from</p>
          <p className="truncate text-sm font-semibold">{context?.name ?? 'Your queue'}</p>
        </div>
        <Link
          to="/queue"
          onClick={() => setOpen(false)}
          aria-label="Queue"
          className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-surface-2"
        >
          <ListMusic size={22} />
        </Link>
      </header>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6">
        <Artwork
          artworkId={track?.artworkId}
          size={640}
          alt={track ? `${track.album.title} cover` : ''}
          className="w-full shadow-2xl"
          rounded="rounded-2xl"
        />
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-bold">{track?.title ?? ' '}</h2>
          <p className="truncate text-muted">
            {track?.artistDisplay}
            {track && (
              <>
                {' · '}
                <Link
                  to={`/album/${track.album.id}`}
                  onClick={() => setOpen(false)}
                  className="hover:underline"
                >
                  {track.album.title}
                </Link>
              </>
            )}
          </p>
        </div>
        <SeekBar />
        <TransportControls />
        <div className="flex items-center justify-between">
          <VolumeControl />
          {tier && <span className="text-xs text-muted">Quality: {TIER_LABEL[tier]}</span>}
        </div>
      </div>
    </div>
  );
}

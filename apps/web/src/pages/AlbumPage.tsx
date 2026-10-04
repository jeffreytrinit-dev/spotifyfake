import type { TrackDto } from '@tidepool/shared';
import { Play, Shuffle } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useAlbum } from '../api/queries.js';
import { useUi } from '../app/ui-store.js';
import { Artwork } from '../components/Artwork.js';
import { Menu } from '../components/Menu.js';
import { Skeleton } from '../components/Skeleton.js';
import { formatDurationLong, formatTime } from '../lib/format.js';
import { usePlayer } from '../player/store.js';

function TrackRow({
  track,
  index,
  onPlay,
  isCurrent,
}: {
  track: TrackDto;
  index: number;
  onPlay(): void;
  isCurrent: boolean;
}) {
  const { playNext, addToQueue } = usePlayer.getState();
  const toast = useUi((s) => s.showToast);
  return (
    <li className="group flex items-center gap-2 rounded-lg pr-1 hover:bg-surface-2">
      <button
        type="button"
        onClick={onPlay}
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2.5 text-left"
        aria-label={`Play ${track.title}`}
      >
        <span
          className={`w-6 shrink-0 text-right text-sm tabular-nums ${isCurrent ? 'text-accent' : 'text-muted'}`}
        >
          {track.trackNumber ?? index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${isCurrent ? 'font-semibold text-accent' : ''}`}>
            {track.title}
          </span>
          <span className="block truncate text-xs text-muted">{track.artistDisplay}</span>
        </span>
        <span className="shrink-0 text-sm tabular-nums text-muted">
          {formatTime(track.durationMs)}
        </span>
      </button>
      <Menu
        label={`More options for ${track.title}`}
        items={[
          {
            label: 'Play next',
            onSelect: () => (playNext([track.id]), toast(`“${track.title}” will play next`)),
          },
          {
            label: 'Add to queue',
            onSelect: () => (addToQueue([track.id]), toast(`Added “${track.title}” to the queue`)),
          },
        ]}
      />
    </li>
  );
}

export function AlbumPage() {
  const { id = '' } = useParams();
  const { data: album, isLoading, isError } = useAlbum(id);
  const currentId = usePlayer((s) => s.queue.current?.trackId);
  const playContext = usePlayer((s) => s.playContext);

  if (isError) return <p className="p-6 text-danger">This album couldn't be loaded.</p>;
  if (isLoading || !album) {
    return (
      <div className="flex flex-col gap-6 p-6 md:flex-row">
        <Skeleton className="aspect-square w-56" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </div>
    );
  }

  const ids = album.tracks.map((t) => t.id);
  const ctx = { type: 'album' as const, id: album.id, name: album.title };
  const discs = [...new Set(album.tracks.map((t) => t.discNumber))];

  return (
    <div>
      <header
        className="flex flex-col items-center gap-5 px-6 pb-6 pt-8 text-center md:flex-row md:items-end md:text-left"
        style={{
          backgroundImage: album.dominantColor
            ? `linear-gradient(to bottom, ${album.dominantColor}55, transparent)`
            : undefined,
        }}
      >
        <Artwork
          artworkId={album.artworkId}
          size={640}
          alt={`${album.title} cover`}
          className="w-56 shadow-2xl md:w-52"
        />
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest text-muted">
            {album.isCompilation ? 'Compilation' : 'Album'}
          </p>
          <h1 className="mt-1 text-3xl font-bold md:text-5xl">{album.title}</h1>
          <p className="mt-2 text-sm text-muted">
            <span className="font-semibold text-fg">{album.artist.name}</span>
            {album.year ? ` · ${album.year}` : ''} · {album.trackCount} songs ·{' '}
            {formatDurationLong(album.durationMs)}
          </p>
        </div>
      </header>

      <div className="flex items-center justify-center gap-3 px-6 pb-4 md:justify-start">
        <button
          type="button"
          onClick={() => playContext(ctx, ids, 0, { shuffle: false })}
          aria-label={`Play ${album.title}`}
          className="inline-flex h-14 items-center gap-2 rounded-full bg-accent px-7 font-semibold text-on-accent shadow-lg hover:bg-accent-strong active:scale-95"
        >
          <Play size={20} fill="currentColor" aria-hidden /> Play
        </button>
        <button
          type="button"
          onClick={() => playContext(ctx, ids, null, { shuffle: true })}
          aria-label={`Shuffle ${album.title}`}
          className="inline-flex h-14 items-center gap-2 rounded-full border border-line px-6 font-semibold hover:bg-surface-2 active:scale-95"
        >
          <Shuffle size={18} aria-hidden /> Shuffle
        </button>
      </div>

      <div className="px-4 pb-8 md:px-6">
        {discs.map((disc) => (
          <section key={disc} aria-label={discs.length > 1 ? `Disc ${disc}` : 'Tracks'}>
            {discs.length > 1 && (
              <h2 className="mb-1 mt-4 px-2 text-sm font-semibold text-muted">Disc {disc}</h2>
            )}
            <ol>
              {album.tracks.map((t, i) =>
                t.discNumber === disc ? (
                  <TrackRow
                    key={t.id}
                    track={t}
                    index={i}
                    isCurrent={t.id === currentId}
                    onPlay={() => playContext(ctx, ids, i)}
                  />
                ) : null,
              )}
            </ol>
          </section>
        ))}
        {album.genres.length > 0 && (
          <p className="mt-6 px-2 text-xs text-muted">{album.genres.join(' · ')}</p>
        )}
        <p className="mt-1 px-2 text-xs text-muted">
          <Link to="/" className="hover:underline">
            Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}

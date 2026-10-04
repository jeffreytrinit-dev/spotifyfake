import type { AlbumSummaryDto } from '@tidepool/shared';
import { Play } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.js';
import { useAlbums } from '../api/queries.js';
import { Artwork } from '../components/Artwork.js';
import { Skeleton } from '../components/Skeleton.js';
import { usePlayer } from '../player/store.js';
import { useTrackCache } from '../player/track-cache.js';
import type { AlbumDetailDto } from '@tidepool/shared';

export function AlbumCard({ album }: { album: AlbumSummaryDto }) {
  const playAlbum = async () => {
    usePlayer.getState().unlockAudio(); // before the await, while we still have the tap
    const detail = await api<AlbumDetailDto>(`/albums/${album.id}`);
    useTrackCache.getState().put(detail.tracks);
    usePlayer.getState().playContext(
      { type: 'album', id: album.id, name: album.title },
      detail.tracks.map((t) => t.id),
      0,
    );
  };
  return (
    <div className="group relative rounded-xl p-2 transition-colors hover:bg-surface-2">
      <Link to={`/album/${album.id}`} className="block">
        <Artwork artworkId={album.artworkId} size={300} alt="" className="w-full shadow-md" />
        <p className="mt-2 truncate text-sm font-semibold">{album.title}</p>
        <p className="truncate text-xs text-muted">
          {album.artist.name}
          {album.year ? ` · ${album.year}` : ''}
        </p>
      </Link>
      <button
        type="button"
        aria-label={`Play ${album.title}`}
        onClick={() => void playAlbum()}
        className="absolute right-4 top-[calc(100%-4.5rem-0.5rem)] hidden h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg group-hover:flex focus:flex"
      >
        <Play size={20} fill="currentColor" />
      </button>
    </div>
  );
}

function AlbumGridSkeleton() {
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="p-2">
          <Skeleton className="aspect-square w-full" />
          <Skeleton className="mt-2 h-4 w-3/4" />
          <Skeleton className="mt-1 h-3 w-1/2" />
        </div>
      ))}
    </>
  );
}

export function HomePage() {
  const albums = useAlbums('added');
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, fetchNextPage, isFetchingNextPage } = albums;

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, fetchNextPage, isFetchingNextPage]);

  const items = albums.data?.pages.flatMap((p) => p.items) ?? [];
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();

  return (
    <div className="px-2 py-6 md:px-6">
      <h1 className="mb-1 px-2 text-2xl font-bold">{greeting}</h1>
      <p className="mb-6 px-2 text-sm text-muted">Recently added to your library</p>
      {albums.isError && (
        <p className="px-2 text-danger">Couldn't load albums. Is the server running?</p>
      )}
      {!albums.isLoading && items.length === 0 && !albums.isError && (
        <div className="mx-2 rounded-2xl border border-dashed border-line p-8 text-center text-muted">
          <p className="font-semibold text-fg">Your library is empty</p>
          <p className="mt-1 text-sm">
            Add music to the folder Tidepool watches and it'll show up here in a few seconds.
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {albums.isLoading ? (
          <AlbumGridSkeleton />
        ) : (
          items.map((a) => <AlbumCard key={a.id} album={a} />)
        )}
      </div>
      <div ref={sentinel} className="h-10" />
    </div>
  );
}

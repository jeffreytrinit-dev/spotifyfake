import { Meilisearch, type EnqueuedTaskPromise, type Index } from 'meilisearch';

export interface TrackDoc {
  id: string;
  title: string;
  artist: string;
  artists: string[];
  album: string;
  albumId: string;
  albumArtist: string;
  genres: string[];
  year: number | null;
  durationMs: number;
  artworkId: string | null;
}

export interface AlbumDoc {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  year: number | null;
  genres: string[];
  artworkId: string | null;
  createdAt: number;
}

export interface ArtistDoc {
  id: string;
  name: string;
  artworkId: string | null;
  albumCount: number;
}

export interface SearchIndexes {
  client: Meilisearch;
  tracks: Index<TrackDoc>;
  albums: Index<AlbumDoc>;
  artists: Index<ArtistDoc>;
}

export function createSearch(url: string, apiKey: string, prefix = ''): SearchIndexes {
  const client = new Meilisearch({ host: url, apiKey });
  return {
    client,
    tracks: client.index<TrackDoc>(`${prefix}tracks`),
    albums: client.index<AlbumDoc>(`${prefix}albums`),
    artists: client.index<ArtistDoc>(`${prefix}artists`),
  };
}

/** Await a Meilisearch task and throw if it failed (the client resolves failed tasks normally). */
export async function waitOk(
  enqueued: EnqueuedTaskPromise,
  { ignore = [] as string[], timeOutMs = 60_000 } = {},
): Promise<void> {
  const task = await enqueued.waitTask({ timeout: timeOutMs });
  if (task.status === 'failed' && !ignore.includes(task.error?.code ?? '')) {
    throw new Error(
      `Meilisearch task ${task.uid} failed: ${task.error?.message ?? 'unknown error'}`,
    );
  }
}

/** Idempotent: creates indexes and applies settings. Safe to call on every boot. */
export async function configureIndexes(s: SearchIndexes): Promise<void> {
  const exists = { ignore: ['index_already_exists'] };
  await Promise.all([
    waitOk(s.client.createIndex(s.tracks.uid, { primaryKey: 'id' }), exists),
    waitOk(s.client.createIndex(s.albums.uid, { primaryKey: 'id' }), exists),
    waitOk(s.client.createIndex(s.artists.uid, { primaryKey: 'id' }), exists),
  ]);
  await Promise.all([
    waitOk(
      s.tracks.updateSettings({
        searchableAttributes: ['title', 'artist', 'artists', 'album', 'albumArtist', 'genres'],
        filterableAttributes: ['genres', 'year', 'albumId'],
        sortableAttributes: ['year', 'title'],
      }),
    ),
    waitOk(
      s.albums.updateSettings({
        searchableAttributes: ['title', 'artist', 'genres'],
        filterableAttributes: ['genres', 'year', 'artistId'],
        sortableAttributes: ['year', 'createdAt', 'title'],
      }),
    ),
    waitOk(
      s.artists.updateSettings({
        searchableAttributes: ['name'],
        sortableAttributes: ['albumCount'],
      }),
    ),
  ]);
}

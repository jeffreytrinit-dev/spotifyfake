import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db.js';
import {
  waitOk,
  type AlbumDoc,
  type ArtistDoc,
  type SearchIndexes,
  type TrackDoc,
} from '../../search/meili.js';

const BATCH = 1000;

function chunks<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Keeps Meilisearch in step with Postgres. Every sync is "load these ids from the DB:
 * visible ones are upserted, the rest deleted", so it's idempotent and self-healing.
 */
export class SearchIndexer {
  constructor(
    private readonly db: Db,
    private readonly search: SearchIndexes,
    private readonly log: FastifyBaseLogger,
  ) {}

  async syncTracks(ids: string[]): Promise<void> {
    for (const batch of chunks(ids)) {
      const rows = await this.db.track.findMany({
        where: { id: { in: batch }, missingSince: null },
        include: {
          album: { include: { albumArtist: { select: { name: true } } } },
          credits: {
            include: { artist: { select: { name: true } } },
            orderBy: { position: 'asc' },
          },
          genres: { include: { genre: { select: { name: true } } } },
        },
      });
      const docs: TrackDoc[] = rows.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artistDisplay,
        artists: t.credits.map((c) => c.artist.name),
        album: t.album.title,
        albumId: t.albumId,
        albumArtist: t.album.albumArtist.name,
        genres: t.genres.map((g) => g.genre.name),
        year: t.year ?? t.album.year,
        durationMs: t.durationMs,
        artworkId: t.artworkId ?? t.album.artworkId,
      }));
      await this.apply(this.search.tracks, docs, batch);
    }
  }

  async syncAlbums(ids: string[]): Promise<void> {
    for (const batch of chunks(ids)) {
      const rows = await this.db.album.findMany({
        where: { id: { in: batch }, trackCount: { gt: 0 } },
        include: {
          albumArtist: { select: { name: true } },
          tracks: {
            where: { missingSince: null },
            select: { genres: { select: { genre: { select: { name: true } } } } },
          },
        },
      });
      const docs: AlbumDoc[] = rows.map((a) => ({
        id: a.id,
        title: a.title,
        artist: a.albumArtist.name,
        artistId: a.albumArtistId,
        year: a.year,
        genres: [...new Set(a.tracks.flatMap((t) => t.genres.map((g) => g.genre.name)))],
        artworkId: a.artworkId,
        createdAt: a.createdAt.getTime(),
      }));
      await this.apply(this.search.albums, docs, batch);
    }
  }

  async syncArtists(ids: string[]): Promise<void> {
    for (const batch of chunks(ids)) {
      const rows = await this.db.artist.findMany({
        where: {
          id: { in: batch },
          OR: [
            { albums: { some: { trackCount: { gt: 0 } } } },
            { trackCredits: { some: { track: { missingSince: null } } } },
          ],
        },
        include: {
          albums: {
            where: { trackCount: { gt: 0 } },
            select: { artworkId: true },
            orderBy: { year: 'desc' },
          },
        },
      });
      const docs: ArtistDoc[] = rows.map((a) => ({
        id: a.id,
        name: a.name,
        artworkId: a.imageId ?? a.albums.find((x) => x.artworkId)?.artworkId ?? null,
        albumCount: a.albums.length,
      }));
      await this.apply(this.search.artists, docs, batch);
    }
  }

  private async apply<D extends { id: string }>(
    index: SearchIndexes['tracks'] | SearchIndexes['albums'] | SearchIndexes['artists'],
    docs: D[],
    requestedIds: string[],
  ): Promise<void> {
    const present = new Set(docs.map((d) => d.id));
    const gone = requestedIds.filter((id) => !present.has(id));
    // The three index types share this path; the doc type is checked by the callers.
    const idx = index as unknown as SearchIndexes['tracks'];
    if (docs.length) await waitOk(idx.addDocuments(docs as unknown as TrackDoc[]));
    if (gone.length) await waitOk(idx.deleteDocuments(gone));
  }

  /** Full rebuild, used when Meilisearch's document counts don't match Postgres (e.g. wiped volume). */
  async reindexAll(): Promise<void> {
    const started = Date.now();
    const [tracks, albums, artists] = await Promise.all([
      this.db.track.findMany({ select: { id: true } }),
      this.db.album.findMany({ select: { id: true } }),
      this.db.artist.findMany({ select: { id: true } }),
    ]);
    await Promise.all([
      waitOk(this.search.tracks.deleteAllDocuments()),
      waitOk(this.search.albums.deleteAllDocuments()),
      waitOk(this.search.artists.deleteAllDocuments()),
    ]);
    await this.syncTracks(tracks.map((t) => t.id));
    await this.syncAlbums(albums.map((a) => a.id));
    await this.syncArtists(artists.map((a) => a.id));
    this.log.info(
      { ms: Date.now() - started, tracks: tracks.length },
      'search: full reindex complete',
    );
  }

  /** True when the index looks out of sync with the DB's visible track count. */
  async needsReindex(): Promise<boolean> {
    const [stats, visible] = await Promise.all([
      this.search.tracks.getStats(),
      this.db.track.count({ where: { missingSince: null } }),
    ]);
    return stats.numberOfDocuments !== visible;
  }
}

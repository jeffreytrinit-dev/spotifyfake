import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IdSchema,
  ListAlbumsQuerySchema,
  ListArtistsQuerySchema,
  ListTracksQuerySchema,
  type AlbumDetailDto,
  type ArtistDetailDto,
  type ArtistDto,
  type GenreDto,
  type Page,
  type TrackDto,
} from '@tidepool/shared';
import type { Db } from '../../db.js';
import { notFound } from '../../errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { parse } from '../../lib/validate.js';
import {
  albumSummaryInclude,
  cursorArgs,
  page,
  toAlbumSummary,
  toTrack,
  trackInclude,
  visibleArtistWhere,
} from './mappers.js';

const IdParams = z.object({ id: IdSchema });

const albumTrackOrder = [
  { discNumber: 'asc' },
  { trackNumber: { sort: 'asc', nulls: 'last' } },
  { sortTitle: 'asc' },
] as const satisfies Prisma.TrackOrderByWithRelationInput[];

export async function catalogRoutes(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  app.get('/artists', async (req): Promise<Page<ArtistDto>> => {
    const q = parse(ListArtistsQuerySchema, req.query);
    const orderBy: Prisma.ArtistOrderByWithRelationInput[] =
      q.sort === 'name'
        ? [{ sortName: 'asc' }, { id: 'asc' }]
        : [{ createdAt: 'desc' }, { id: 'asc' }];
    const rows = await db.artist.findMany({
      where: visibleArtistWhere,
      orderBy,
      ...cursorArgs(q.cursor, q.limit),
      include: {
        albums: {
          where: { trackCount: { gt: 0 } },
          select: { artworkId: true },
          orderBy: { year: 'desc' },
        },
      },
    });
    return page(rows, q.limit, (a) => ({
      id: a.id,
      name: a.name,
      sortName: a.sortName,
      artworkId: a.imageId ?? a.albums.find((x) => x.artworkId)?.artworkId ?? null,
      albumCount: a.albums.length,
    }));
  });

  app.get('/artists/:id', async (req): Promise<ArtistDetailDto> => {
    const { id } = parse(IdParams, req.params);
    const artist = await db.artist.findUnique({ where: { id } });
    if (!artist) throw notFound('Artist');
    const [albums, appearsOn] = await Promise.all([
      db.album.findMany({
        where: { albumArtistId: id, trackCount: { gt: 0 } },
        orderBy: [{ year: { sort: 'desc', nulls: 'last' } }, { sortTitle: 'asc' }],
        include: albumSummaryInclude,
      }),
      db.album.findMany({
        where: {
          albumArtistId: { not: id },
          trackCount: { gt: 0 },
          tracks: { some: { missingSince: null, credits: { some: { artistId: id } } } },
        },
        orderBy: [{ year: { sort: 'desc', nulls: 'last' } }, { sortTitle: 'asc' }],
        include: albumSummaryInclude,
      }),
    ]);
    return {
      id: artist.id,
      name: artist.name,
      sortName: artist.sortName,
      artworkId: artist.imageId ?? albums.find((a) => a.artworkId)?.artworkId ?? null,
      albumCount: albums.length,
      albums: albums.map(toAlbumSummary),
      appearsOn: appearsOn.map(toAlbumSummary),
    };
  });

  app.get('/albums', async (req) => {
    const q = parse(ListAlbumsQuerySchema, req.query);
    const orderBy: Prisma.AlbumOrderByWithRelationInput[] = {
      added: [{ createdAt: 'desc' }, { id: 'asc' }],
      name: [{ sortTitle: 'asc' }, { id: 'asc' }],
      year: [{ year: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      artist: [{ albumArtist: { sortName: 'asc' } }, { year: 'asc' }, { id: 'asc' }],
    }[q.sort] as Prisma.AlbumOrderByWithRelationInput[];
    const rows = await db.album.findMany({
      where: {
        trackCount: { gt: 0 },
        ...(q.artistId ? { albumArtistId: q.artistId } : {}),
        ...(q.genre
          ? { tracks: { some: { missingSince: null, genres: { some: { genreId: q.genre } } } } }
          : {}),
      },
      orderBy,
      ...cursorArgs(q.cursor, q.limit),
      include: albumSummaryInclude,
    });
    return page(rows, q.limit, toAlbumSummary);
  });

  app.get('/albums/:id', async (req): Promise<AlbumDetailDto> => {
    const { id } = parse(IdParams, req.params);
    const album = await db.album.findUnique({
      where: { id },
      include: {
        ...albumSummaryInclude,
        tracks: { where: { missingSince: null }, orderBy: albumTrackOrder, include: trackInclude },
      },
    });
    if (!album) throw notFound('Album');
    const tracks = album.tracks.map(toTrack);
    return {
      ...toAlbumSummary(album),
      discCount: album.discCount,
      genres: [...new Set(tracks.flatMap((t) => t.genres))],
      tracks,
    };
  });

  app.get('/tracks', async (req): Promise<Page<TrackDto>> => {
    const q = parse(ListTracksQuerySchema, req.query);
    if (q.ids) {
      // Batch fetch keeps the caller's order; includes missing tracks (flagged) so queues can show them.
      const rows = await db.track.findMany({ where: { id: { in: q.ids } }, include: trackInclude });
      const byId = new Map(rows.map((r) => [r.id, toTrack(r)]));
      return { items: q.ids.flatMap((id) => byId.get(id) ?? []), nextCursor: null };
    }
    const rows = await db.track.findMany({
      where: { missingSince: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      ...cursorArgs(q.cursor, q.limit),
      include: trackInclude,
    });
    return page(rows, q.limit, toTrack);
  });

  app.get('/tracks/:id', async (req): Promise<TrackDto> => {
    const { id } = parse(IdParams, req.params);
    const track = await db.track.findUnique({ where: { id }, include: trackInclude });
    if (!track) throw notFound('Track');
    return toTrack(track);
  });

  app.get('/genres', async (): Promise<GenreDto[]> => {
    const genres = await db.genre.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { tracks: { where: { track: { missingSince: null } } } } } },
    });
    return genres
      .filter((g) => g._count.tracks > 0)
      .map((g) => ({ id: g.id, name: g.name, trackCount: g._count.tracks }));
  });
}

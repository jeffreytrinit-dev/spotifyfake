import type { AlbumSummaryDto, TrackDto } from '@tidepool/shared';
import type { Prisma } from '../../generated/prisma/client.js';

export const albumSummaryInclude = {
  albumArtist: { select: { id: true, name: true } },
  artwork: { select: { dominantColor: true } },
} as const satisfies Prisma.AlbumInclude;

export type AlbumWithSummary = Prisma.AlbumGetPayload<{ include: typeof albumSummaryInclude }>;

export function toAlbumSummary(a: AlbumWithSummary): AlbumSummaryDto {
  return {
    id: a.id,
    title: a.title,
    year: a.year,
    artist: { id: a.albumArtist.id, name: a.albumArtist.name },
    artworkId: a.artworkId,
    dominantColor: a.artwork?.dominantColor ?? null,
    trackCount: a.trackCount,
    durationMs: a.durationMs,
    isCompilation: a.isCompilation,
    createdAt: a.createdAt.toISOString(),
  };
}

export const trackInclude = {
  album: {
    select: {
      id: true,
      title: true,
      year: true,
      artworkId: true,
      replayGainDb: true,
      replayPeak: true,
      albumArtist: { select: { id: true, name: true } },
    },
  },
  credits: {
    include: { artist: { select: { id: true, name: true } } },
    orderBy: { position: 'asc' },
  },
  genres: { include: { genre: { select: { name: true } } } },
} as const satisfies Prisma.TrackInclude;

export type TrackWithRelations = Prisma.TrackGetPayload<{ include: typeof trackInclude }>;

export function toTrack(t: TrackWithRelations): TrackDto {
  return {
    id: t.id,
    title: t.title,
    artistDisplay: t.artistDisplay,
    artists: t.credits.map((c) => ({ id: c.artist.id, name: c.artist.name, role: c.role })),
    album: { id: t.album.id, title: t.album.title },
    albumArtist: { id: t.album.albumArtist.id, name: t.album.albumArtist.name },
    trackNumber: t.trackNumber,
    discNumber: t.discNumber,
    year: t.year ?? t.album.year,
    durationMs: t.durationMs,
    genres: t.genres.map((g) => g.genre.name),
    artworkId: t.artworkId ?? t.album.artworkId,
    format: {
      container: t.container,
      codec: t.codec,
      bitrate: t.bitrate,
      sampleRate: t.sampleRate,
      bitDepth: t.bitDepth,
      channels: t.channels,
      lossless: t.lossless,
      sizeBytes: Number(t.fileSize),
    },
    loudness: {
      replayGainDb: t.replayGainDb,
      replayPeak: t.replayPeak,
      albumGainDb: t.album.replayGainDb,
      albumPeak: t.album.replayPeak,
    },
    missing: t.missingSince !== null,
  };
}

/** Artists that have something playable: an album with present tracks, or a present credited track. */
export const visibleArtistWhere = {
  OR: [
    { albums: { some: { trackCount: { gt: 0 } } } },
    { trackCredits: { some: { track: { missingSince: null } } } },
  ],
} as const satisfies Prisma.ArtistWhereInput;

/** Cursor pagination helper: fetch one extra row to know whether there's a next page. */
export function page<T extends { id: string }, R>(rows: T[], limit: number, map: (row: T) => R) {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  return { items: slice.map(map), nextCursor: hasMore ? (slice.at(-1)?.id ?? null) : null };
}

export function cursorArgs(cursor: string | undefined, limit: number) {
  return { take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
}

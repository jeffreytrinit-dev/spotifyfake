import { z } from 'zod';
import { IdSchema, PaginationQuerySchema } from './common.js';

export const ArtSizeSchema = z.enum(['64', '300', '640', 'orig']);
export type ArtSize = z.infer<typeof ArtSizeSchema>;

export const ListArtistsQuerySchema = PaginationQuerySchema.extend({
  sort: z.enum(['name', 'added']).default('name'),
});

export const ListAlbumsQuerySchema = PaginationQuerySchema.extend({
  sort: z.enum(['added', 'name', 'year', 'artist']).default('added'),
  genre: IdSchema.optional(),
  artistId: IdSchema.optional(),
});

export const ListTracksQuerySchema = PaginationQuerySchema.extend({
  /** Comma-separated batch fetch; when present, pagination is ignored. */
  ids: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(IdSchema).max(200))
    .optional(),
});

export interface ArtistRefDto {
  id: string;
  name: string;
}

export interface ArtistDto extends ArtistRefDto {
  sortName: string;
  artworkId: string | null;
  albumCount: number;
}

export interface AlbumSummaryDto {
  id: string;
  title: string;
  year: number | null;
  artist: ArtistRefDto;
  artworkId: string | null;
  dominantColor: string | null;
  trackCount: number;
  durationMs: number;
  isCompilation: boolean;
  createdAt: string;
}

export interface TrackDto {
  id: string;
  title: string;
  artistDisplay: string;
  artists: (ArtistRefDto & { role: string })[];
  album: { id: string; title: string };
  albumArtist: ArtistRefDto;
  trackNumber: number | null;
  discNumber: number;
  year: number | null;
  durationMs: number;
  genres: string[];
  artworkId: string | null;
  format: {
    container: string;
    codec: string;
    bitrate: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
    channels: number | null;
    lossless: boolean;
    sizeBytes: number;
  };
  loudness: {
    replayGainDb: number | null;
    replayPeak: number | null;
    albumGainDb: number | null;
    albumPeak: number | null;
  };
  missing: boolean;
}

export interface AlbumDetailDto extends AlbumSummaryDto {
  discCount: number;
  genres: string[];
  tracks: TrackDto[];
}

export interface ArtistDetailDto extends ArtistDto {
  albums: AlbumSummaryDto[];
  /** Albums by other album-artists where this artist is credited on a track. */
  appearsOn: AlbumSummaryDto[];
}

export interface GenreDto {
  id: string;
  name: string;
  trackCount: number;
}

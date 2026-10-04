import { z } from 'zod';

export const StartScanRequestSchema = z
  .object({
    /** Re-read every file even if size + mtime are unchanged. */
    full: z.boolean().default(false),
  })
  .default({ full: false });
export type StartScanRequest = z.infer<typeof StartScanRequestSchema>;

export type ScanStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ScanError {
  path: string;
  message: string;
}

export interface ScanRunDto {
  id: string;
  trigger: string;
  status: ScanStatus;
  startedAt: string;
  finishedAt: string | null;
  filesSeen: number;
  added: number;
  updated: number;
  moved: number;
  removed: number;
  errors: ScanError[];
}

export interface LibraryStatsDto {
  tracks: number;
  albums: number;
  artists: number;
  genres: number;
  missingTracks: number;
  totalDurationMs: number;
  totalSizeBytes: number;
}

export interface MissingTrackDto {
  id: string;
  title: string;
  artistDisplay: string;
  album: { id: string; title: string };
  /** Last known library-relative path. */
  path: string;
  missingSince: string;
  /** What a purge would remove along with the track. */
  playlistEntries: number;
  liked: boolean;
  plays: number;
}

export const PurgeMissingRequestSchema = z.object({
  /** Omit to purge every missing track. */
  trackIds: z
    .array(z.string().regex(/^[a-z0-9]{20,32}$/))
    .min(1)
    .max(1000)
    .optional(),
});
export type PurgeMissingRequest = z.infer<typeof PurgeMissingRequestSchema>;

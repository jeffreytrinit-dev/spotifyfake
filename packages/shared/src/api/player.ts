import { z } from 'zod';
import { IdSchema } from './common.js';

/** Upper bound on context size kept in a queue (e.g. "play all songs"). */
export const MAX_QUEUE_ENTRIES = 5000;

export const QueueEntrySchema = z.object({
  /** Unique per entry, so the same track can be queued twice and drag-and-drop has stable keys. */
  uid: z.string().min(1).max(40),
  trackId: IdSchema,
  /** "queue" = added by the user (Play next / Add to queue); "context" = from the album/playlist. */
  origin: z.enum(['context', 'queue']),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

export const PlayContextSchema = z.object({
  type: z.enum(['album', 'artist', 'playlist', 'liked', 'tracks', 'search', 'radio']),
  id: z.string().max(64).nullable(),
  name: z.string().max(200),
});
export type PlayContext = z.infer<typeof PlayContextSchema>;

export const RepeatModeSchema = z.enum(['off', 'all', 'one']);
export type RepeatMode = z.infer<typeof RepeatModeSchema>;

export const QueueSnapshotSchema = z.object({
  context: PlayContextSchema.nullable(),
  /** Context entries in their natural order (used to rebuild order when shuffle changes). */
  source: z.array(QueueEntrySchema).max(MAX_QUEUE_ENTRIES),
  current: QueueEntrySchema.nullable(),
  /** User-queued entries, played before the rest of the context. */
  upNext: z.array(QueueEntrySchema).max(1000),
  /** Remaining context entries in play order (shuffled or natural). */
  later: z.array(QueueEntrySchema).max(MAX_QUEUE_ENTRIES),
  /** Played entries, oldest first. */
  history: z.array(QueueEntrySchema).max(200),
  shuffle: z.boolean(),
  repeat: RepeatModeSchema,
});
export type QueueSnapshot = z.infer<typeof QueueSnapshotSchema>;

export const SavePlayerStateSchema = z.object({
  queue: QueueSnapshotSchema,
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600 * 1000),
  isPlaying: z.boolean(),
  volume: z.number().min(0).max(1),
  deviceId: z.uuid().optional(),
  /** Version the client last saw; a mismatch returns 409 with the stored state. */
  version: z.number().int().min(0).optional(),
});
export type SavePlayerState = z.infer<typeof SavePlayerStateSchema>;

export interface PlayerStateDto {
  queue: QueueSnapshot;
  positionMs: number;
  isPlaying: boolean;
  volume: number;
  activeDeviceId: string | null;
  version: number;
  updatedAt: string;
}

export const PlayEventSchema = z.object({
  /** Client-generated, makes re-sending (e.g. after being offline) idempotent. */
  clientEventId: z.uuid(),
  trackId: IdSchema,
  startedAt: z.iso.datetime(),
  msPlayed: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600 * 1000),
  percentPlayed: z.number().min(0).max(1),
  skipped: z.boolean(),
  contextType: PlayContextSchema.shape.type.optional(),
  contextId: z.string().max(64).optional(),
  playedOffline: z.boolean().optional(),
});
export type PlayEventInput = z.infer<typeof PlayEventSchema>;

export const PostPlaysSchema = z.object({ events: z.array(PlayEventSchema).min(1).max(200) });

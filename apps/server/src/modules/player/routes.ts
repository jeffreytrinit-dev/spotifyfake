import type { FastifyInstance } from 'fastify';
import { QueueSnapshotSchema, SavePlayerStateSchema, type PlayerStateDto } from '@tidepool/shared';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import type { PlaybackState } from '../../generated/prisma/client.js';
import { parse } from '../../lib/validate.js';
import { currentUser } from '../auth/plugin.js';

function toDto(s: PlaybackState): PlayerStateDto | null {
  const queue = QueueSnapshotSchema.safeParse(s.queue);
  if (!queue.success) return null; // e.g. written by an older client version
  return {
    queue: queue.data,
    positionMs: s.positionMs,
    isPlaying: s.isPlaying,
    volume: s.volume,
    activeDeviceId: s.activeDeviceId,
    version: s.version,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * The user's saved player (queue, position, volume). The browser also keeps a local copy for
 * instant restore; this one lets another device or a fresh install pick up where you left off.
 */
export async function playerRoutes(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  app.get('/me/player', async (req): Promise<PlayerStateDto | null> => {
    const state = await db.playbackState.findUnique({ where: { userId: currentUser(req).id } });
    return state ? toDto(state) : null;
  });

  // Queues of a few thousand tracks exceed the default 1 MiB body limit.
  app.put('/me/player', { bodyLimit: 4 << 20 }, async (req) => {
    const user = currentUser(req);
    const body = parse(SavePlayerStateSchema, req.body);
    const data = {
      queue: body.queue,
      currentTrackId: body.queue.current?.trackId ?? null,
      positionMs: body.positionMs,
      positionUpdatedAt: new Date(),
      isPlaying: body.isPlaying,
      volume: body.volume,
      shuffle: body.queue.shuffle,
      repeat: body.queue.repeat.toUpperCase() as 'OFF' | 'ALL' | 'ONE',
      activeDeviceId: body.deviceId ?? null,
    };

    return db.$transaction(async (tx) => {
      const existing = await tx.playbackState.findUnique({ where: { userId: user.id } });
      if (existing && body.version !== undefined && body.version !== existing.version) {
        throw new AppError(409, 'STALE_PLAYER_STATE', 'Player state changed on another device', {
          current: toDto(existing),
        });
      }
      const saved = existing
        ? await tx.playbackState.update({
            where: { userId: user.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.playbackState.create({ data: { userId: user.id, ...data, version: 1 } });
      return { version: saved.version };
    });
  });
}

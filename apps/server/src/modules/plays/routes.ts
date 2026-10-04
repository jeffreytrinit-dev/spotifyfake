import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PostPlaysSchema } from '@tidepool/shared';
import type { Db } from '../../db.js';
import { parse } from '../../lib/validate.js';
import { currentUser } from '../auth/plugin.js';

/** Plays closer together than this belong to one listening session (a co-listening signal). */
const SESSION_GAP_MS = 30 * 60_000;

export async function playRoutes(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  /** Record finished plays. Idempotent per clientEventId, so offline batches can be re-sent. */
  app.post('/plays', async (req) => {
    const user = currentUser(req);
    const { events } = parse(PostPlaysSchema, req.body);
    const sorted = [...events].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    // Only tracks that exist; unknown ids (purged since) are dropped rather than failing the batch.
    const known = new Set(
      (
        await db.track.findMany({
          where: { id: { in: sorted.map((e) => e.trackId) } },
          select: { id: true },
        })
      ).map((t) => t.id),
    );

    const previous = await db.playEvent.findFirst({
      where: { userId: user.id, startedAt: { lt: new Date(sorted[0]!.startedAt) } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, msPlayed: true, listeningSessionId: true },
    });
    let lastEnd = previous ? previous.startedAt.getTime() + previous.msPlayed : -Infinity;
    let sessionId = previous?.listeningSessionId ?? randomUUID();

    const rows = sorted
      .filter((e) => known.has(e.trackId))
      .map((e) => {
        const start = new Date(e.startedAt).getTime();
        if (start - lastEnd > SESSION_GAP_MS) sessionId = randomUUID();
        lastEnd = Math.max(lastEnd, start + e.msPlayed);
        return {
          clientEventId: e.clientEventId,
          userId: user.id,
          trackId: e.trackId,
          listeningSessionId: sessionId,
          startedAt: new Date(start),
          msPlayed: e.msPlayed,
          percentPlayed: e.percentPlayed,
          skipped: e.skipped,
          contextType: e.contextType ?? null,
          contextId: e.contextId ?? null,
          playedOffline: e.playedOffline ?? false,
        };
      });
    const { count } = await db.playEvent.createMany({ data: rows, skipDuplicates: true });
    return { accepted: count, ignored: events.length - count };
  });
}

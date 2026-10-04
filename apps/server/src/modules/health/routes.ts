import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db.js';
import { run } from '../../lib/process.js';
import type { SearchIndexes } from '../../search/meili.js';

let ffmpegVersion: Promise<string | null> | null = null;
function checkFfmpeg(): Promise<string | null> {
  ffmpegVersion ??= run('ffmpeg', ['-hide_banner', '-version'], { timeoutMs: 5000 })
    .then(({ stdout }) => stdout.split('\n')[0] ?? 'unknown')
    .catch(() => null);
  return ffmpegVersion;
}

export async function healthRoutes(app: FastifyInstance, opts: { db: Db; search: SearchIndexes }) {
  app.get('/healthz', { config: { public: true } }, async (_req, reply) => {
    const [db, search, ffmpeg] = await Promise.all([
      opts.db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      opts.search.client.isHealthy().catch(() => false),
      checkFfmpeg(),
    ]);
    const ok = db && search && ffmpeg !== null;
    reply.code(ok ? 200 : 503);
    return { ok, db, search, ffmpeg: ffmpeg !== null };
  });
}

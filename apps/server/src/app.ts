import fs from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { ApiErrorBody } from '@tidepool/shared';
import { createDb, type Db } from './db.js';
import type { Env } from './env.js';
import { AppError } from './errors.js';
import { loggerOptions } from './logger.js';
import { artworkRoutes } from './modules/artwork/routes.js';
import { authPlugin } from './modules/auth/plugin.js';
import { authRoutes } from './modules/auth/routes.js';
import { SessionStore } from './modules/auth/sessions.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { ArtworkStore } from './modules/library/artwork.js';
import { SearchIndexer } from './modules/library/indexer.js';
import { libraryRoutes } from './modules/library/routes.js';
import { LibraryService } from './modules/library/service.js';
import { LibraryWatcher } from './modules/library/watcher.js';
import { configureIndexes, createSearch, type SearchIndexes } from './search/meili.js';

export interface AppContext {
  env: Env;
  db: Db;
  search: SearchIndexes;
  library: LibraryService;
  indexer: SearchIndexer;
  sessions: SessionStore;
  /** Run on close, before the DB disconnects (background work registers itself here). */
  onShutdown: (() => Promise<void>)[];
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

/** Build the app without listening or starting background work (tests use this directly). */
export async function buildApp(env: Env, overrides: { db?: Db } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(env),
    trustProxy: true, // behind Caddy
    bodyLimit: 1 << 20,
  });

  await fs.mkdir(env.DATA_DIR, { recursive: true });
  const db = overrides.db ?? createDb(env.DATABASE_URL);
  const search = createSearch(env.MEILI_URL, env.MEILI_MASTER_KEY, env.MEILI_INDEX_PREFIX);
  const artwork = new ArtworkStore(db, env.DATA_DIR, app.log.child({ module: 'artwork' }));
  const indexer = new SearchIndexer(db, search, app.log.child({ module: 'search' }));
  const library = new LibraryService({
    db,
    env,
    artwork,
    indexer,
    log: app.log.child({ module: 'library' }),
  });
  const sessions = new SessionStore(db, env.SESSION_TTL_DAYS);
  const ctx: AppContext = { env, db, search, library, indexer, sessions, onShutdown: [] };
  app.decorate('ctx', ctx);

  app.setErrorHandler((err, req, reply) => {
    let status = 500;
    let body: ApiErrorBody = { error: { code: 'INTERNAL', message: 'Internal server error' } };
    if (err instanceof AppError) {
      status = err.statusCode;
      body = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      };
    } else if (
      err instanceof Error &&
      'statusCode' in err &&
      typeof err.statusCode === 'number' &&
      err.statusCode < 500
    ) {
      // Fastify's own 4xx errors (bad JSON, body too large, rate limit, …)
      status = err.statusCode;
      body = {
        error: { code: status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message: err.message },
      };
    }
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found' } } satisfies ApiErrorBody);
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin, { sessions });

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { db, search });
      await api.register(authRoutes, {
        db,
        sessions,
        secureCookies: env.PUBLIC_URL.startsWith('https://'),
      });
      await api.register(libraryRoutes, { library });
      await api.register(catalogRoutes, { db });
      await api.register(artworkRoutes, { db, dataDir: env.DATA_DIR });
    },
    { prefix: '/api/v1' },
  );

  app.addHook('onClose', async () => {
    for (const task of ctx.onShutdown) await task();
    await library.idle();
    await db.$disconnect();
  });
  return app;
}

/** Boot-time background work: search setup, initial scan, file watcher. */
export async function startBackground(app: FastifyInstance): Promise<void> {
  const { env, search, library, indexer, sessions } = app.ctx;
  const log = app.log;

  // A scan that was running when the process died will never finish; close it out.
  await app.ctx.db.scanRun.updateMany({
    where: { status: 'RUNNING' },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      errors: [{ path: '(scan)', message: 'interrupted by server restart' }],
    },
  });

  await configureIndexes(search);
  if (await indexer.needsReindex()) await indexer.reindexAll();
  await sessions.purgeExpired();

  const musicDirOk = await fs
    .stat(env.MUSIC_DIR)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!musicDirOk) {
    log.error(
      { dir: env.MUSIC_DIR },
      'MUSIC_DIR does not exist or is not a directory; scanning disabled',
    );
    return;
  }
  if (env.SCAN_ON_STARTUP) await library.startFullScan('startup');
  if (env.WATCH_LIBRARY) {
    const watcher = new LibraryWatcher(env.MUSIC_DIR, library, log.child({ module: 'watcher' }), {
      polling: env.WATCH_POLLING,
    });
    await watcher.start();
    app.ctx.onShutdown.push(() => watcher.stop());
    log.info({ dir: env.MUSIC_DIR, polling: env.WATCH_POLLING }, 'watching library for changes');
  }
}

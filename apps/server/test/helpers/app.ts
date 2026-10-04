import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/env.js';
import { configureIndexes, waitOk } from '../../src/search/meili.js';
import { testDatabaseUrl } from '../global-setup.js';
import { createFixtureLibrary, type FixtureLibrary } from './fixtures.js';

config({ path: path.join(import.meta.dirname, '../../../../.env'), quiet: true });

export interface TestApp {
  app: FastifyInstance;
  env: Env;
  lib: FixtureLibrary;
  close: () => Promise<void>;
}

const TABLES = [
  'PlaybackState',
  'Device',
  'RecentSearch',
  'TrackCooccurrence',
  'PlayEvent',
  'TrackLike',
  'PlaylistTrack',
  'Playlist',
  'ScanRun',
  'TranscodeCache',
  'Lyrics',
  'TrackGenre',
  'Genre',
  'TrackArtist',
  'Track',
  'Album',
  'Artist',
  'Artwork',
  'UserSettings',
  'Session',
  'User',
];

/** A fully wired app on a clean test DB, fresh fixture library and its own Meilisearch indexes. */
export async function createTestApp(
  overrides: Partial<Record<keyof Env, string>> = {},
): Promise<TestApp> {
  const lib = await createFixtureLibrary();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tidepool-data-'));
  const prefix = `test_${Math.random().toString(36).slice(2, 10)}_`;
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDatabaseUrl(),
    MUSIC_DIR: lib.root,
    DATA_DIR: dataDir,
    MEILI_INDEX_PREFIX: prefix,
    SCAN_ON_STARTUP: 'false',
    WATCH_LIBRARY: 'false',
    SCAN_CONCURRENCY: '2',
    LOUDNESS_ANALYSIS: 'false',
    WEB_DIR: path.join(dataDir, 'no-web'),
    ...overrides,
  });
  const app = await buildApp(env);
  await app.ctx.db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  await configureIndexes(app.ctx.search);

  return {
    app,
    env,
    lib,
    close: async () => {
      const s = app.ctx.search;
      await Promise.all(
        [s.tracks, s.albums, s.artists].map((i) => waitOk(s.client.deleteIndex(i.uid))),
      );
      await app.close();
      await fs.rm(lib.root, { recursive: true, force: true });
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Run a full scan to completion and return its result. */
export async function scanAndWait(app: FastifyInstance, forceReread = false) {
  const id = await app.ctx.library.startFullScan('manual', forceReread);
  await app.ctx.library.idle();
  return app.ctx.library.getScan(id);
}

export async function signUpAdmin(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { email: 'admin@example.com', displayName: 'Admin', password: 'a-long-password' },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'tp_session');
  return `tp_session=${cookie!.value}`;
}

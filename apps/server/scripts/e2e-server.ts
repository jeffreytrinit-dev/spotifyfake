/**
 * Starts a throwaway Tidepool for the Playwright suite: its own database (created if needed,
 * wiped every run), a generated fixture library, and the built web app.
 *   E2E_DATABASE_URL (default: DATABASE_URL with database "tidepool_e2e"), E2E_PORT (3999)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import pg from 'pg';
import { buildApp, startBackground } from '../src/app.js';
import { loadEnv } from '../src/env.js';
import { writeFixtureLibrary } from '../test/helpers/fixtures.js';

const root = path.join(import.meta.dirname, '..');
config({ path: path.join(root, '../../.env'), quiet: true });

const base = new URL(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
if (!process.env.E2E_DATABASE_URL) base.pathname = '/tidepool_e2e';
const dbName = base.pathname.slice(1);

// Create the database if missing, then reset it.
const admin = new URL(base);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (!exists.rowCount) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
await client.end();
const db = new pg.Client({ connectionString: base.toString() });
await db.connect();
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await db.end();
execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: base.toString() },
  stdio: 'ignore',
});

const work = path.join(os.tmpdir(), 'tidepool-e2e');
await fs.rm(work, { recursive: true, force: true });
await writeFixtureLibrary(path.join(work, 'music'), { long: true });

const env = loadEnv({
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  DATABASE_URL: base.toString(),
  PORT: process.env.E2E_PORT ?? '3999',
  HOST: '127.0.0.1',
  MUSIC_DIR: path.join(work, 'music'),
  DATA_DIR: path.join(work, 'data'),
  MEILI_INDEX_PREFIX: 'e2e_',
  WEB_DIR: path.join(root, '../web/dist'),
  SCAN_ON_STARTUP: 'true',
  WATCH_LIBRARY: 'false',
  LOUDNESS_ANALYSIS: 'true',
});
const app = await buildApp(env);
// Scan before listening, so the suite never sees a half-scanned library.
await startBackground(app);
await app.ctx.library.idle();
await app.listen({ host: env.HOST, port: env.PORT });
console.log(`e2e server ready on ${env.PORT}`);

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';

/**
 * Tests use TEST_DATABASE_URL (default: the dev URL with database "tidepool_test") and an
 * index prefix in Meilisearch, so they never touch dev data.
 */
export default function setup(): void {
  config({ path: path.join(import.meta.dirname, '../../../.env'), quiet: true });
  const url = testDatabaseUrl();
  process.env.TEST_DATABASE_URL = url;
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('Set DATABASE_URL or TEST_DATABASE_URL to run integration tests');
  const u = new URL(base);
  u.pathname = '/tidepool_test';
  return u.toString();
}

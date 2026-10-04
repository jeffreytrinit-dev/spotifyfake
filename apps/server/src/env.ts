import path from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  MEILI_URL: z.url(),
  MEILI_MASTER_KEY: z.string().min(16, 'MEILI_MASTER_KEY must be at least 16 bytes'),
  /** Prefix for Meilisearch index names (lets tests run against a shared instance). */
  MEILI_INDEX_PREFIX: z
    .string()
    .regex(/^[a-z0-9_]*$/)
    .default(''),

  MUSIC_DIR: z
    .string()
    .min(1)
    .transform((p) => path.resolve(p)),
  DATA_DIR: z
    .string()
    .min(1)
    .transform((p) => path.resolve(p)),

  SCAN_ON_STARTUP: bool.default(true),
  WATCH_LIBRARY: bool.default(true),
  WATCH_POLLING: bool.default(false),
  /** Auto-purge tracks missing longer than this many days. 0 = never (purge manually in settings). */
  MISSING_GRACE_DAYS: z.coerce.number().int().min(0).default(0),
  SCAN_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

  TRANSCODE_CACHE_MAX_GB: z.coerce.number().min(0.1).default(10),
  /** Simultaneous ffmpeg transcodes (2 suits a Raspberry Pi 5; raise on a desktop). */
  TRANSCODE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  TRANSCODE_TIMEOUT_SEC: z.coerce.number().int().min(10).default(600),

  /** Measure loudness (ffmpeg ebur128) for tracks without ReplayGain tags, in the background. */
  LOUDNESS_ANALYSIS: bool.default(true),
  /** Built web app to serve (apps/web/dist). Missing → API only. */
  WEB_DIR: z
    .string()
    .default('../web/dist')
    .transform((p) => path.resolve(p)),

  SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(30),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

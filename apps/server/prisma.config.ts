import { config } from 'dotenv';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

// The repo keeps a single .env at the root; an app-local one may override it.
config({
  path: [path.join(import.meta.dirname, '.env'), path.join(import.meta.dirname, '../../.env')],
  quiet: true,
});

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Fallback lets `prisma generate` run without a database (e.g. in Docker builds).
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/placeholder',
  },
});

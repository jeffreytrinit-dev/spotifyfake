import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IdSchema,
  PaginationQuerySchema,
  PurgeMissingRequestSchema,
  StartScanRequestSchema,
} from '@tidepool/shared';
import { forbidden } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { currentUser } from '../auth/plugin.js';
import type { LibraryService } from './service.js';

export async function libraryRoutes(
  app: FastifyInstance,
  { library }: { library: LibraryService },
) {
  // Library-wide operations affect every user, so they're admin-only.
  const requireAdmin = async (req: Parameters<typeof currentUser>[0]) => {
    if (currentUser(req).role !== 'ADMIN') throw forbidden('Admin only');
  };

  app.post('/library/scan', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parse(StartScanRequestSchema, req.body ?? {});
    const scanId = await library.startFullScan('manual', body.full);
    reply.code(202);
    return { scanId };
  });

  app.get('/library/scan/:id', async (req) => {
    const { id } = parse(z.object({ id: IdSchema }), req.params);
    return library.getScan(id);
  });

  app.get('/library/scans', async () => library.listScans());

  app.get('/library/stats', async () => library.stats());

  app.get('/library/missing', async (req) => {
    const q = parse(PaginationQuerySchema, req.query);
    return library.listMissing(q.cursor, q.limit);
  });

  app.post('/library/missing/purge', { preHandler: requireAdmin }, async (req) => {
    const body = parse(PurgeMissingRequestSchema, req.body ?? {});
    return library.purgeMissing(body.trackIds ?? null);
  });
}

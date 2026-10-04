import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ArtSizeSchema, IdSchema } from '@tidepool/shared';
import type { Db } from '../../db.js';
import { notFound } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { artworkFile } from '../library/artwork.js';

const Params = z.object({ id: IdSchema, size: ArtSizeSchema });

export async function artworkRoutes(app: FastifyInstance, opts: { db: Db; dataDir: string }) {
  app.get('/art/:id/:size', async (req, reply) => {
    const { id, size } = parse(Params, req.params);
    const art = await opts.db.artwork.findUnique({ where: { id }, select: { hash: true } });
    if (!art) throw notFound('Artwork');

    // The file name derives only from a DB-stored hex hash (validated in artworkFile), never
    // from request input, so there is no path to traverse.
    const file = artworkFile(
      opts.dataDir,
      art.hash,
      size === 'orig' ? 'orig' : (Number(size) as 64 | 300 | 640),
    );
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) throw notFound('Artwork file');

    const etag = `"${art.hash.slice(0, 16)}-${size}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=31536000, immutable');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.type('image/webp').header('Content-Length', stat.size);
    return reply.send(createReadStream(file));
  });
}

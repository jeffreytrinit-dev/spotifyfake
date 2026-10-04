import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { notFound } from '../../errors.js';
import { parseRange } from './range.js';

export interface SendFileOptions {
  mime: string;
  /** Strong validator; must change whenever the bytes change. */
  etag: string;
  headers?: Record<string, string>;
}

/**
 * Serve a file with full HTTP Range support (single ranges), conditional requests and HEAD.
 * Media elements, iOS Safari in particular, rely on 206 responses to start and to seek.
 */
export async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: string,
  opts: SendFileOptions,
): Promise<FastifyReply> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw notFound('Audio file');
  const size = stat.size;

  reply
    .header('Accept-Ranges', 'bytes')
    .header('Content-Type', opts.mime)
    .header('ETag', opts.etag)
    .header('Cache-Control', 'private, no-cache');
  for (const [k, v] of Object.entries(opts.headers ?? {})) reply.header(k, v);

  if (req.headers['if-none-match'] === opts.etag && !req.headers.range) {
    return reply.code(304).send();
  }

  // If-Range: only honour the Range if the client's copy is still current.
  const ifRange = req.headers['if-range'];
  const rangeHeader = ifRange && ifRange !== opts.etag ? undefined : req.headers.range;
  const range = parseRange(rangeHeader, size);

  if (range === 'unsatisfiable') {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  reply.header('Content-Length', length);
  if (range) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);

  if (req.method === 'HEAD') {
    // Fastify would reset Content-Length to 0 for an empty body, so write the head ourselves.
    reply.hijack();
    reply.raw.writeHead(reply.statusCode, reply.getHeaders() as Record<string, string | number>);
    reply.raw.end();
    return reply;
  }
  if (length === 0) return reply.send();
  return reply.send(createReadStream(file, { start, end }));
}

import fs from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** Applied to the HTML shell: the app only ever talks to its own origin. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:", // data: = the silent clip used to unlock audio on iOS
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const NO_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'registerSW.js']);

/**
 * Serves the built web app (apps/web/dist) from the API server, so one address serves both.
 * Hashed assets are cached forever; the shell and service worker are always revalidated.
 * Unknown non-API GETs return index.html so client-side routes work on reload.
 */
export async function registerWebApp(app: FastifyInstance, webDir: string): Promise<boolean> {
  const index = path.join(webDir, 'index.html');
  const html = await fs.readFile(index, 'utf8').catch(() => null);
  if (html === null) {
    app.log.warn({ webDir }, 'web app not built; serving the API only');
    return false;
  }

  await app.register(fastifyStatic, {
    root: webDir,
    wildcard: false,
    index: false,
    setHeaders(res, filePath) {
      const name = path.basename(filePath);
      res.header('X-Content-Type-Options', 'nosniff');
      if (NO_CACHE.has(name)) res.header('Cache-Control', 'no-cache');
      else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  const sendShell = (reply: FastifyReply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .header('Content-Security-Policy', CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .send(html);

  app.get('/', { config: { public: true } }, (_req, reply) => sendShell(reply));
  app.get('/*', { config: { public: true } }, async (req, reply) => {
    const url = req.url.split('?')[0] ?? '/';
    if (url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    }
    // Real files (JS, icons, sw.js…) are served as-is; anything else is a client route.
    const rel = decodeURIComponent(url).replace(/^\/+/, '');
    if (rel && !rel.includes('..')) {
      const stat = await fs.stat(path.join(webDir, rel)).catch(() => null);
      if (stat?.isFile()) return reply.sendFile(rel);
    }
    if (path.extname(rel)) return reply.code(404).send('Not found');
    return sendShell(reply);
  });
  return true;
}

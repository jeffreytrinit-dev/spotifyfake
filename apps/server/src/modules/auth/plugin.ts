import type {} from '@fastify/cookie';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../../errors.js';
import { SESSION_COOKIE, type SessionStore, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
  }
  interface FastifyContextConfig {
    /** Route is reachable without a session. */
    public?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The authenticated user; only call from routes that aren't `public`. */
export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export const authPlugin = fp(
  async (app: FastifyInstance, opts: { sessions: SessionStore }) => {
    app.decorateRequest('user', null);
    app.decorateRequest('sessionId', null);

    app.addHook('onRequest', async (req) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) {
        const resolved = await opts.sessions.resolve(token);
        if (resolved) {
          req.user = resolved.user;
          req.sessionId = resolved.sessionId;
        }
      }

      // CSRF: browsers can't add custom headers to cross-site form posts / simple requests,
      // so requiring one on cookie-authenticated writes (alongside SameSite=Lax) blocks CSRF.
      if (!SAFE_METHODS.has(req.method) && token && !req.headers['x-requested-with']) {
        throw forbidden('Missing X-Requested-With header');
      }

      if (!req.routeOptions.config.public && !req.user) throw unauthorized();
    });
  },
  { name: 'auth', dependencies: ['@fastify/cookie'] },
);

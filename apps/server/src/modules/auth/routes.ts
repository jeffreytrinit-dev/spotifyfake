import type {} from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { LoginRequestSchema, SetupRequestSchema, type MeResponse } from '@tidepool/shared';
import type { Db } from '../../db.js';
import { isUniqueViolation } from '../../db.js';
import { AppError, conflict } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { getDummyHash, hashPassword, verifyPassword } from './password.js';
import { currentUser } from './plugin.js';
import { SESSION_COOKIE, type SessionStore } from './sessions.js';

export async function authRoutes(
  app: FastifyInstance,
  opts: { db: Db; sessions: SessionStore; secureCookies: boolean },
): Promise<void> {
  const { db, sessions } = opts;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: opts.secureCookies,
    maxAge: Math.floor(sessions.ttlMs / 1000),
  };

  app.get('/auth/setup', { config: { public: true } }, async () => {
    return { needsSetup: (await db.user.count()) === 0 };
  });

  /** First-run only: creates the admin account and signs it in. */
  app.post(
    '/auth/setup',
    { config: { public: true, rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(SetupRequestSchema, req.body);
      if ((await db.user.count()) > 0) throw conflict('Setup has already been completed');
      const passwordHash = await hashPassword(body.password);
      let user;
      try {
        // Serializable so two racing setup requests can't both create an admin.
        user = await db.$transaction(
          async (tx) => {
            if ((await tx.user.count()) > 0) throw conflict('Setup has already been completed');
            return tx.user.create({
              data: {
                email: body.email,
                displayName: body.displayName,
                passwordHash,
                role: 'ADMIN',
                settings: { create: {} },
              },
            });
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (isUniqueViolation(err)) throw conflict('Setup has already been completed');
        throw err;
      }
      const token = await sessions.create(user.id, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      reply.setCookie(SESSION_COOKIE, token, cookieOptions).code(201);
      return toMe(user);
    },
  );

  app.post(
    '/auth/login',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(LoginRequestSchema, req.body);
      const user = await db.user.findUnique({ where: { email: body.email } });
      const ok = user
        ? await verifyPassword(user.passwordHash, body.password)
        : (await verifyPassword(await getDummyHash(), body.password), false);
      if (!user || !ok)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

      const token = await sessions.create(user.id, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      reply.setCookie(SESSION_COOKIE, token, cookieOptions);
      return toMe(user);
    },
  );

  app.post('/auth/logout', { config: { public: true } }, async (req, reply) => {
    if (req.sessionId) await sessions.revoke(req.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204);
  });

  app.get('/me', async (req) => toMe(currentUser(req)));
}

function toMe(u: {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'USER';
}): MeResponse {
  return { id: u.id, email: u.email, displayName: u.displayName, role: u.role };
}

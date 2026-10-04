import { randomBytes } from 'node:crypto';
import type { Db } from '../../db.js';
import { sha256 } from '../../lib/hash.js';

export const SESSION_COOKIE = 'tp_session';
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'USER';
}

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly ttlDays: number,
  ) {}

  get ttlMs(): number {
    return this.ttlDays * 86_400_000;
  }

  /** Returns the raw token for the cookie; only its hash is stored. */
  async create(
    userId: string,
    meta: { userAgent?: string | undefined; ip?: string | undefined },
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        ip: meta.ip ?? null,
        expiresAt: new Date(Date.now() + this.ttlMs),
      },
    });
    return token;
  }

  /** Resolve a token to its user, sliding the expiry forward at most once an hour. */
  async resolve(token: string): Promise<{ sessionId: string; user: SessionUser } | null> {
    if (!token || token.length > 128) return null;
    const session = await this.db.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { id: true, email: true, displayName: true, role: true } } },
    });
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now) {
      await this.db.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }
    if (now - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.session.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date(now), expiresAt: new Date(now + this.ttlMs) },
      });
    }
    return { sessionId: session.id, user: session.user };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.session.deleteMany({ where: { id: sessionId } });
  }

  async purgeExpired(): Promise<number> {
    const { count } = await this.db.session.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    return count;
  }
}

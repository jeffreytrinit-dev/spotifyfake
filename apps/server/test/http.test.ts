import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AlbumDetailDto,
  AlbumSummaryDto,
  ArtistDetailDto,
  Page,
  TrackDto,
} from '@tidepool/shared';
import { hashPassword } from '../src/modules/auth/password.js';
import { createTestApp, scanAndWait, signUpAdmin, type TestApp } from './helpers/app.js';

let t: TestApp;
let admin: string;
const W = { 'x-requested-with': 'test' };

beforeAll(async () => {
  t = await createTestApp();
  admin = await signUpAdmin(t.app);
  await scanAndWait(t.app);
});
afterAll(() => t.close());

const get = (url: string, cookie = admin) =>
  t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie } });
const post = (
  url: string,
  payload: object = {},
  cookie = admin,
  headers: Record<string, string> = W,
) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: { cookie, ...headers } });

describe('auth', () => {
  it('reports setup done and refuses a second setup', async () => {
    expect((await get('/auth/setup', '')).json()).toEqual({ needsSetup: false });
    const res = await post(
      '/auth/setup',
      { email: 'x@example.com', displayName: 'X', password: 'another-long-pw' },
      '',
    );
    expect(res.statusCode).toBe(409);
  });

  it('requires a session for API routes', async () => {
    expect((await get('/albums', '')).statusCode).toBe(401);
    expect((await get('/albums', 'tp_session=bogus')).statusCode).toBe(401);
  });

  it('logs in case-insensitively, rejects bad passwords, and logs out', async () => {
    const bad = await post(
      '/auth/login',
      { email: 'admin@example.com', password: 'wrong-password' },
      '',
    );
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await post(
      '/auth/login',
      { email: 'nobody@example.com', password: 'whatever-pw' },
      '',
    );
    expect(unknown.statusCode).toBe(401);

    const ok = await post(
      '/auth/login',
      { email: 'ADMIN@example.com', password: 'a-long-password' },
      '',
    );
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === 'tp_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    const session = `tp_session=${cookie.value}`;
    expect((await get('/me', session)).json()).toMatchObject({
      email: 'admin@example.com',
      role: 'ADMIN',
    });

    expect((await post('/auth/logout', {}, session)).statusCode).toBe(204);
    expect((await get('/me', session)).statusCode).toBe(401);
  });

  it('marks the cookie Secure when the request came in over HTTPS through a proxy', async () => {
    const plain = await post(
      '/auth/login',
      { email: 'admin@example.com', password: 'a-long-password' },
      '',
    );
    expect(plain.cookies.find((c) => c.name === 'tp_session')!.secure).toBeFalsy();
    const viaTls = await post(
      '/auth/login',
      { email: 'admin@example.com', password: 'a-long-password' },
      '',
      {
        ...W,
        'x-forwarded-proto': 'https',
      },
    );
    expect(viaTls.cookies.find((c) => c.name === 'tp_session')!.secure).toBe(true);
  });

  it('stores only a hash of the session token', async () => {
    const token = admin.split('=')[1]!;
    const sessions = await t.app.ctx.db.session.findMany();
    expect(sessions.every((s) => s.tokenHash !== token && /^[a-f0-9]{64}$/.test(s.tokenHash))).toBe(
      true,
    );
  });

  it('rejects cookie-authenticated writes without X-Requested-With (CSRF)', async () => {
    const res = await post('/library/scan', {}, admin, {});
    expect(res.statusCode).toBe(403);
  });

  it('validates input', async () => {
    const res = await post('/auth/login', { email: 'not-an-email', password: '' }, '');
    expect(res.statusCode).toBe(400);
    expect(
      res
        .json()
        .error.details.map((d: { path: string }) => d.path)
        .sort(),
    ).toEqual(['email', 'password']);
  });

  it('rate-limits login attempts', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await post('/auth/login', { email: 'admin@example.com', password: 'nope-nope' }, ''))
          .statusCode,
      );
    }
    expect(statuses).toContain(429);
  });
});

describe('library admin routes', () => {
  it('starts a scan and reports progress', async () => {
    const res = await post('/library/scan', { full: false });
    expect(res.statusCode).toBe(202);
    const { scanId } = res.json();
    await t.app.ctx.library.idle();
    expect((await get(`/library/scan/${scanId}`)).json()).toMatchObject({
      status: 'COMPLETED',
      filesSeen: 5,
    });
    expect((await get('/library/stats')).json()).toMatchObject({
      tracks: 5,
      albums: 3,
      missingTracks: 0,
    });
  });

  it('is admin-only for scans and purges', async () => {
    const user = await t.app.ctx.db.user.create({
      data: {
        email: 'user@example.com',
        displayName: 'U',
        passwordHash: await hashPassword('user-password-1'),
      },
    });
    // Session created directly: the login route is rate-limited by the test above.
    const cookie = `tp_session=${await t.app.ctx.sessions.create(user.id, {})}`;
    expect((await post('/library/scan', {}, cookie)).statusCode).toBe(403);
    expect((await post('/library/missing/purge', {}, cookie)).statusCode).toBe(403);
    expect((await get('/library/stats', cookie)).statusCode).toBe(200);
  });
});

describe('catalog', () => {
  it('lists albums newest first with cursor pagination', async () => {
    const first = (await get('/albums?limit=2')).json() as Page<AlbumSummaryDto>;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await get(`/albums?limit=2&cursor=${first.nextCursor}`)
    ).json() as Page<AlbumSummaryDto>;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((a) => a.title).sort();
    expect(all).toEqual(['Compilation Hits', 'Folder Album', 'Tagged Album']);
  });

  it('returns album detail with ordered tracks and genres', async () => {
    const albums = (await get('/albums?sort=name')).json() as Page<AlbumSummaryDto>;
    const tagged = albums.items.find((a) => a.title === 'Tagged Album')!;
    expect(tagged.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    const detail = (await get(`/albums/${tagged.id}`)).json() as AlbumDetailDto;
    expect(detail.tracks.map((tr) => tr.title)).toEqual(['First Song', 'Second Song']);
    expect(detail.genres.sort()).toEqual(['Indie', 'Rock']);
    expect(detail.tracks[0]!.loudness.replayGainDb).toBe(-6.5);
    expect(detail.tracks[1]!.artists.map((a) => a.role)).toEqual(['main', 'featured']);
  });

  it('returns artist detail including appears-on', async () => {
    const artists = (await get('/artists')).json() as Page<{ id: string; name: string }>;
    expect(artists.items.map((a) => a.name)).toEqual([
      'Comp Artist',
      'Folder Artist',
      'Guest One',
      'Tagged Artist',
      'Various Artists',
    ]);
    const guest = artists.items.find((a) => a.name === 'Guest One')!;
    const detail = (await get(`/artists/${guest.id}`)).json() as ArtistDetailDto;
    expect(detail.albums).toEqual([]);
    expect(detail.appearsOn.map((a) => a.title)).toEqual(['Tagged Album']);
  });

  it('batch-fetches tracks preserving order and skipping unknown ids', async () => {
    const page = (await get('/tracks')).json() as Page<TrackDto>;
    const ids = page.items.map((x) => x.id).reverse();
    const res = (
      await get(`/tracks?ids=${[ids[0], 'zzzzzzzzzzzzzzzzzzzzzzzzz', ids[1]].join(',')}`)
    ).json() as Page<TrackDto>;
    expect(res.items.map((x) => x.id)).toEqual([ids[0], ids[1]]);
  });

  it('lists genres with counts', async () => {
    expect((await get('/genres')).json()).toEqual([
      expect.objectContaining({ name: 'Indie', trackCount: 1 }),
      expect.objectContaining({ name: 'Pop', trackCount: 1 }),
      expect.objectContaining({ name: 'Rock', trackCount: 2 }),
    ]);
  });

  it('404s unknown ids and 400s malformed ones', async () => {
    expect((await get('/albums/aaaaaaaaaaaaaaaaaaaaaaaaa')).statusCode).toBe(404);
    expect((await get('/albums/..%2F..%2Fetc')).statusCode).toBe(400);
  });
});

describe('artwork', () => {
  it('serves WebP thumbnails with caching headers and 304s', async () => {
    const art = await t.app.ctx.db.artwork.findFirstOrThrow();
    const res = await get(`/art/${art.id}/300`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.rawPayload.subarray(8, 12).toString()).toBe('WEBP');

    const again = await t.app.inject({
      method: 'GET',
      url: `/api/v1/art/${art.id}/300`,
      headers: { cookie: admin, 'if-none-match': String(res.headers.etag) },
    });
    expect(again.statusCode).toBe(304);
  });

  it('rejects unknown sizes and traversal attempts', async () => {
    const art = await t.app.ctx.db.artwork.findFirstOrThrow();
    expect((await get(`/art/${art.id}/1000`)).statusCode).toBe(400);
    expect((await get(`/art/${art.id}/..%2F..%2F..%2Fetc%2Fpasswd`)).statusCode).toBe(400);
  });
});

describe('health', () => {
  it('reports dependencies without auth', async () => {
    const res = await get('/healthz', '');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: true, search: true, ffmpeg: true });
  });
});

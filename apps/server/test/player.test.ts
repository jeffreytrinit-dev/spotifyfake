import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayerStateDto, QueueSnapshot } from '@tidepool/shared';
import { LoudnessAnalyzer } from '../src/modules/library/loudness.js';
import { createTestApp, scanAndWait, signUpAdmin, type TestApp } from './helpers/app.js';

const W = { 'x-requested-with': 't' };

describe('player state, plays and loudness', () => {
  let t: TestApp;
  let cookie: string;
  let trackIds: string[];

  beforeAll(async () => {
    t = await createTestApp();
    cookie = await signUpAdmin(t.app);
    await scanAndWait(t.app);
    trackIds = (await t.app.ctx.db.track.findMany({ orderBy: { path: 'asc' } })).map((x) => x.id);
  });
  afterAll(() => t.close());

  const queue = (): QueueSnapshot => ({
    context: { type: 'album', id: 'x', name: 'Album' },
    source: trackIds.map((id, i) => ({ uid: `s${i}`, trackId: id, origin: 'context' })),
    current: { uid: 'c0', trackId: trackIds[0]!, origin: 'context' },
    upNext: [{ uid: 'q0', trackId: trackIds[2]!, origin: 'queue' }],
    later: trackIds.slice(1).map((id, i) => ({ uid: `l${i}`, trackId: id, origin: 'context' })),
    history: [],
    shuffle: false,
    repeat: 'all',
  });
  const put = (body: object) =>
    t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/player',
      headers: { cookie, ...W },
      payload: body,
    });

  describe('saved player', () => {
    it('is null before anything was saved, then round-trips', async () => {
      expect(
        (
          await t.app.inject({ method: 'GET', url: '/api/v1/me/player', headers: { cookie } })
        ).json(),
      ).toBeNull();
      const deviceId = randomUUID();
      const res = await put({
        queue: queue(),
        positionMs: 1234,
        isPlaying: true,
        volume: 0.5,
        deviceId,
      });
      expect(res.json()).toEqual({ version: 1 });
      const got = (
        await t.app.inject({ method: 'GET', url: '/api/v1/me/player', headers: { cookie } })
      ).json() as PlayerStateDto;
      expect(got).toMatchObject({
        positionMs: 1234,
        isPlaying: true,
        volume: 0.5,
        activeDeviceId: deviceId,
        version: 1,
      });
      expect(got.queue).toEqual(queue());
      const row = await t.app.ctx.db.playbackState.findFirstOrThrow();
      expect(row).toMatchObject({ currentTrackId: trackIds[0], repeat: 'ALL', shuffle: false });
    });

    it('rejects a stale version with the current state, and accepts the right one', async () => {
      const stale = await put({
        queue: queue(),
        positionMs: 1,
        isPlaying: false,
        volume: 1,
        version: 0,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toMatchObject({
        code: 'STALE_PLAYER_STATE',
        details: { current: { version: 1 } },
      });
      expect(
        (
          await put({ queue: queue(), positionMs: 2, isPlaying: false, volume: 1, version: 1 })
        ).json(),
      ).toEqual({ version: 2 });
    });

    it('validates the queue shape', async () => {
      const bad = { ...queue(), repeat: 'sometimes' };
      expect(
        (await put({ queue: bad, positionMs: 0, isPlaying: false, volume: 1 })).statusCode,
      ).toBe(400);
      expect(
        (await put({ queue: queue(), positionMs: 0, isPlaying: false, volume: 2 })).statusCode,
      ).toBe(400);
    });
  });

  describe('plays', () => {
    const event = (minutesAgo: number, trackId = trackIds[0]!) => ({
      clientEventId: randomUUID(),
      trackId,
      startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      msPlayed: 60_000,
      percentPlayed: 0.9,
      skipped: false,
      contextType: 'album',
    });
    const post = (events: object[]) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/plays',
        headers: { cookie, ...W },
        payload: { events },
      });

    it('records plays, ignores re-sent ones and unknown tracks', async () => {
      const a = event(200);
      const b = event(195);
      expect((await post([a, b])).json()).toEqual({ accepted: 2, ignored: 0 });
      expect((await post([a, b, event(190, 'zzzzzzzzzzzzzzzzzzzzzzzzz')])).json()).toEqual({
        accepted: 0,
        ignored: 3,
      });
    });

    it('groups plays into listening sessions split by 30-minute gaps', async () => {
      await t.app.ctx.db.playEvent.deleteMany();
      await post([event(120), event(117), event(115), event(60), event(58)]);
      const rows = await t.app.ctx.db.playEvent.findMany({ orderBy: { startedAt: 'asc' } });
      const sessions = rows.map((r) => r.listeningSessionId);
      expect(new Set(sessions.slice(0, 3)).size).toBe(1);
      expect(new Set(sessions.slice(3)).size).toBe(1);
      expect(sessions[0]).not.toBe(sessions[3]);
      // A later batch continues the session it belongs to.
      await post([event(56)]);
      const last = await t.app.ctx.db.playEvent.findFirstOrThrow({
        orderBy: { startedAt: 'desc' },
      });
      expect(last.listeningSessionId).toBe(sessions[3]);
    });
  });

  describe('loudness analysis', () => {
    it('measures untagged tracks, derives album gain, and keeps tagged values', async () => {
      const analyzer = new LoudnessAnalyzer(t.app.ctx.db, t.env.MUSIC_DIR, t.app.log);
      await analyzer.kick();
      const tracks = await t.app.ctx.db.track.findMany({ include: { album: true } });
      for (const tr of tracks) {
        expect(tr.replayGainDb).not.toBeNull();
        expect(tr.loudnessSource).not.toBeNull();
      }
      const flac = tracks.find((x) => x.path === t.lib.files.flac)!;
      expect(flac).toMatchObject({ replayGainDb: -6.5, loudnessSource: 'TAG' }); // tag wins
      const wav = tracks.find((x) => x.path === t.lib.files.wav)!;
      expect(wav.loudnessSource).toBe('ANALYZED');
      expect(wav.loudnessLufs).toBeLessThan(0);
      expect(wav.replayGainDb).toBeCloseTo(-18 - wav.loudnessLufs!, 1);
      expect(wav.replayPeak).toBeGreaterThan(0);
      // Folder Album: both tracks analysed → album gain filled in.
      expect(wav.album.replayGainDb).not.toBeNull();

      // Nothing left to do on the next pass.
      const before = await t.app.ctx.db.track.findMany({ select: { updatedAt: true } });
      await analyzer.kick();
      expect(await t.app.ctx.db.track.findMany({ select: { updatedAt: true } })).toEqual(before);
    });
  });
});

describe('serving the web app', () => {
  let t: TestApp;
  let webDir: string;

  beforeAll(async () => {
    webDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-web-'));
    await fs.mkdir(path.join(webDir, 'assets'));
    await fs.writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>Tidepool</title>');
    await fs.writeFile(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
    await fs.writeFile(path.join(webDir, 'sw.js'), '// sw');
    t = await createTestApp({ WEB_DIR: webDir });
  });
  afterAll(async () => {
    await t.close();
    await fs.rm(webDir, { recursive: true, force: true });
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url });

  it('serves the shell for client-side routes without a session, with a CSP', async () => {
    for (const url of ['/', '/album/abc', '/settings?x=1']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<title>Tidepool</title>');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('caches hashed assets forever but always revalidates the service worker', async () => {
    const asset = await get('/assets/app-abc123.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await get('/sw.js')).headers['cache-control']).toBe('no-cache');
  });

  it('keeps the API JSON and authenticated', async () => {
    expect((await get('/api/v1/nope')).json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect((await get('/api/v1/albums')).statusCode).toBe(401);
    expect((await get('/missing.js')).statusCode).toBe(404);
    expect((await get('/../../etc/passwd')).body).not.toContain('root:');
  });
});

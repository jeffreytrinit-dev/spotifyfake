import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StreamInfoDto, UserSettingsDto } from '@tidepool/shared';
import { run } from '../src/lib/process.js';
import { Transcoder } from '../src/modules/stream/transcoder.js';
import { createTestApp, scanAndWait, signUpAdmin, type TestApp } from './helpers/app.js';

let t: TestApp;
let cookie: string;
const ids: Record<'flac' | 'mp3' | 'wav' | 'opus' | 'm4a', string> = {
  flac: '',
  mp3: '',
  wav: '',
  opus: '',
  m4a: '',
};

const DESKTOP = 'mp3,aac,mp4-aac,flac,ogg-opus,ogg-vorbis,webm-opus,wav';
const IPHONE = 'mp3,aac,mp4-aac,mp4-alac,flac,wav';

beforeAll(async () => {
  t = await createTestApp();
  cookie = await signUpAdmin(t.app);
  await scanAndWait(t.app);
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) {
    ids[k] = (await t.app.ctx.db.track.findUniqueOrThrow({ where: { path: t.lib.files[k] } })).id;
  }
});
afterAll(() => t.close());

const get = (url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie, ...headers } });

async function probe(bytes: Buffer, ext: string) {
  const file = path.join(t.env.DATA_DIR, `probe-${Math.random().toString(36).slice(2)}.${ext}`);
  await fs.writeFile(file, bytes);
  try {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration:stream=codec_name',
      '-of',
      'json',
      file,
    ]);
    const j = JSON.parse(stdout) as {
      format: { format_name: string; duration?: string };
      streams: { codec_name: string }[];
    };
    return {
      format: j.format.format_name,
      codec: j.streams[0]?.codec_name,
      duration: Number(j.format.duration),
    };
  } finally {
    await fs.rm(file);
  }
}

describe('originals', () => {
  it('serve byte ranges, including the 2-byte probe Safari sends first', async () => {
    const res = await get(`/stream/${ids.flac}?q=lossless&formats=${DESKTOP}`, {
      range: 'bytes=0-1',
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toMatch(/^bytes 0-1\/\d+$/);
    expect(res.headers['content-type']).toBe('audio/flac');
    expect(res.rawPayload.toString('latin1')).toBe('fL');

    const size = Number(String(res.headers['content-range']).split('/')[1]);
    const tail = await get(`/stream/${ids.flac}/original`, { range: 'bytes=-10' });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers['content-range']).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    expect(tail.rawPayload).toHaveLength(10);

    const whole = await get(`/stream/${ids.flac}/original`);
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.rawPayload).toEqual(await fs.readFile(path.join(t.lib.root, t.lib.files.flac)));
  });

  it('answers 416 past the end, and ignores a Range when If-Range is stale', async () => {
    const r416 = await get(`/stream/${ids.flac}/original`, { range: 'bytes=99999999-' });
    expect(r416.statusCode).toBe(416);
    expect(r416.headers['content-range']).toMatch(/^bytes \*\/\d+$/);

    const stale = await get(`/stream/${ids.flac}/original`, {
      range: 'bytes=0-1',
      'if-range': '"old"',
    });
    expect(stale.statusCode).toBe(200);
  });

  it('supports HEAD without a body', async () => {
    const res = await t.app.inject({
      method: 'HEAD',
      url: `/api/v1/stream/${ids.flac}/original`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(res.rawPayload).toHaveLength(0);
  });

  it('are used for lossy files already at or below the tier (never transcode up)', async () => {
    const res = await get(`/stream/${ids.mp3}?q=high&formats=${DESKTOP}`, { range: 'bytes=0-' });
    expect(res.statusCode).toBe(206);
    expect(res.headers['x-tidepool-source']).toBe('original');
    expect(res.headers['content-type']).toBe('audio/mpeg');
  });
});

describe('transcodes', () => {
  it('stream live on first play, then serve the cached file with ranges', async () => {
    const live = await get(`/stream/${ids.flac}?q=high&formats=${DESKTOP}`, { range: 'bytes=0-1' });
    expect(live.statusCode).toBe(200); // Range ignored while the length is unknown
    expect(live.headers['x-tidepool-live']).toBe('1');
    expect(live.headers['accept-ranges']).toBe('none');
    expect(live.headers['content-type']).toBe('audio/webm');
    expect(await probe(live.rawPayload, 'webm')).toMatchObject({ codec: 'opus' });
    await t.app.ctx.transcoder.idle();

    const cached = await get(`/stream/${ids.flac}?q=high&formats=${DESKTOP}`, {
      range: 'bytes=0-1',
    });
    expect(cached.statusCode).toBe(206);
    expect(cached.headers['x-tidepool-profile']).toBe('opus320');
    const full = await get(`/stream/${ids.flac}?q=high&formats=${DESKTOP}`);
    const p = await probe(full.rawPayload, 'webm');
    expect(p).toMatchObject({ codec: 'opus' });
    expect(p.duration).toBeCloseTo(3, 0); // cached file has a real duration (seekable)

    const row = await t.app.ctx.db.transcodeCache.findUniqueOrThrow({
      where: { trackId_profile: { trackId: ids.flac, profile: 'opus320' } },
    });
    expect(Number(row.sizeBytes)).toBe(full.rawPayload.length);
  });

  it('fall back to AAC for an iPhone without Opus: ADTS while live, MP4 once cached', async () => {
    const live = await get(`/stream/${ids.opus}?q=normal&formats=${IPHONE}`);
    expect(live.headers['content-type']).toBe('audio/aac');
    expect(await probe(live.rawPayload, 'aac')).toMatchObject({ format: 'aac', codec: 'aac' });
    await t.app.ctx.transcoder.idle();

    const cached = await get(`/stream/${ids.opus}?q=normal&formats=${IPHONE}`);
    expect(cached.headers['content-type']).toBe('audio/mp4');
    // The Opus fixture is 64 kbps, so the compatibility transcode doesn't inflate it to 160.
    expect(cached.headers['x-tidepool-profile']).toBe('aac96');
    expect((await probe(cached.rawPayload, 'm4a')).format).toContain('mp4');
  });

  it('let a second request join a running job from byte 0 (Safari probes, hangs up, re-requests)', async () => {
    const src = { id: ids.m4a, absPath: path.join(t.lib.root, t.lib.files.m4a), quickHash: 'x' };
    const row = await t.app.ctx.db.track.findUniqueOrThrow({ where: { id: ids.m4a } });
    src.quickHash = row.quickHash;
    const job = t.app.ctx.transcoder.ensure(src, 'opus96', { live: true });
    expect(t.app.ctx.transcoder.ensure(src, 'opus96', { live: true })).toBe(job); // single flight

    const [a, b] = await Promise.all([job.openLiveStream(), job.openLiveStream()]);
    a.destroy(); // first listener disconnects early
    const chunks: Buffer[] = [];
    for await (const c of b) chunks.push(c as Buffer);
    expect((await probe(Buffer.concat(chunks), 'webm')).codec).toBe('opus');
    await expect(job.done).resolves.toMatchObject({ sizeBytes: expect.any(Number) });
  });

  it('turn WAV into FLAC at Lossless, and wait=1 returns a seekable file', async () => {
    const res = await get(`/stream/${ids.wav}?q=lossless&formats=${IPHONE}&wait=1`, {
      range: 'bytes=0-3',
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['x-tidepool-profile']).toBe('flac');
    expect(res.rawPayload.toString('latin1')).toBe('fLaC');
  });

  it('describe the plan via /info and warm the cache via /prepare', async () => {
    const info = (
      await get(`/stream/${ids.m4a}/info?q=low&formats=${IPHONE}`)
    ).json() as StreamInfoDto;
    expect(info).toMatchObject({
      source: 'transcode',
      profile: 'aac96',
      seekable: false,
      mime: 'audio/aac',
    });

    const prep = await t.app.inject({
      method: 'POST',
      url: `/api/v1/stream/${ids.m4a}/prepare?q=low&formats=${IPHONE}`,
      headers: { cookie, 'x-requested-with': 't' },
    });
    expect(prep.statusCode).toBe(202);
    await t.app.ctx.transcoder.idle();
    const after = (
      await get(`/stream/${ids.m4a}/info?q=low&formats=${IPHONE}`)
    ).json() as StreamInfoDto;
    expect(after).toMatchObject({
      seekable: true,
      mime: 'audio/mp4',
      sizeBytes: expect.any(Number),
    });
  });

  it('do not start work for a HEAD request', async () => {
    const res = await t.app.inject({
      method: 'HEAD',
      url: `/api/v1/stream/${ids.mp3}?q=low&formats=webm-opus`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(t.app.ctx.transcoder.running(ids.mp3, 'opus96')).toBeUndefined();
  });

  it('are invalidated when the source file changes', async () => {
    await get(`/stream/${ids.flac}?q=normal&formats=${DESKTOP}&wait=1`);
    const before = await t.app.ctx.db.transcodeCache.findUniqueOrThrow({
      where: { trackId_profile: { trackId: ids.flac, profile: 'opus160' } },
    });
    await t.app.ctx.db.track.update({ where: { id: ids.flac }, data: { quickHash: 'changed' } });
    try {
      const res = await get(`/stream/${ids.flac}/info?q=normal&formats=${DESKTOP}`);
      expect(res.json()).toMatchObject({ seekable: false });
      await expect(fs.access(path.join(t.env.DATA_DIR, before.path))).rejects.toThrow();
    } finally {
      await t.app.ctx.db.track.update({
        where: { id: ids.flac },
        data: { quickHash: before.sourceHash },
      });
    }
  });

  it('use the user setting when no quality is given', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/settings',
      headers: { cookie, 'x-requested-with': 't' },
      payload: { streamQualityWifi: 'LOW' },
    });
    const info = (await get(`/stream/${ids.flac}/info?formats=${DESKTOP}`)).json() as StreamInfoDto;
    expect(info).toMatchObject({ tier: 'LOW', profile: 'opus96' });
  });
});

describe('failures', () => {
  it('fall back to the original when ffmpeg fails, or 502 if the client cannot play it', async () => {
    // Scan a valid MP3, then swap garbage in underneath (same path) so ffmpeg fails on it.
    const file = path.join(t.lib.root, 'Broken/broken.mp3');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await run('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=123:duration=2',
      '-b:a',
      '192k',
      file,
    ]);
    await scanAndWait(t.app);
    const track = await t.app.ctx.db.track.findUniqueOrThrow({
      where: { path: 'Broken/broken.mp3' },
    });
    await fs.writeFile(file, Buffer.alloc(50_000, 0x41));

    const live = await get(`/stream/${track.id}?q=low&formats=mp3,webm-opus`);
    expect(live.statusCode).toBe(200);
    expect(live.headers['x-tidepool-fallback']).toBe('original');

    // Backing off now: answered immediately without spawning ffmpeg again.
    expect(t.app.ctx.transcoder.isBackingOff(track.id, 'opus96')).toBe(true);
    const unplayable = await get(`/stream/${track.id}?q=low&formats=webm-opus`);
    expect(unplayable.statusCode).toBe(502);
    expect(unplayable.json().error.code).toBe('TRANSCODE_FAILED');
  });

  it('404 for unknown or missing tracks and refuse paths outside the library', async () => {
    expect((await get('/stream/aaaaaaaaaaaaaaaaaaaaaaaaa')).statusCode).toBe(404);
    const t2 = await t.app.ctx.db.track.findUniqueOrThrow({ where: { id: ids.mp3 } });
    await t.app.ctx.db.track.update({
      where: { id: ids.mp3 },
      data: { path: '../../../etc/passwd' },
    });
    try {
      const res = await get(`/stream/${ids.mp3}/original`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_PATH');
    } finally {
      await t.app.ctx.db.track.update({ where: { id: ids.mp3 }, data: { path: t2.path } });
    }
  });

  it('require a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/stream/${ids.mp3}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('cache eviction', () => {
  it('removes least recently used transcodes beyond the size cap', async () => {
    const rows = await t.app.ctx.db.transcodeCache.findMany({ orderBy: { lastAccessedAt: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const newest = rows.at(-1)!;
    // Room for exactly the newest entry.
    const small = new Transcoder(t.app.ctx.db, t.env.DATA_DIR, t.app.log, {
      concurrency: 1,
      maxBytes: Number(newest.sizeBytes),
      timeoutMs: 10_000,
    });
    expect(await small.evict()).toBe(rows.length - 1);
    const left = await t.app.ctx.db.transcodeCache.findMany();
    expect(left.map((r) => r.id)).toEqual([newest.id]);
    for (const r of rows.slice(0, -1)) {
      await expect(fs.access(path.join(t.env.DATA_DIR, r.path))).rejects.toThrow();
    }
  });
});

describe('settings', () => {
  it('round-trips and validates', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/settings',
      headers: { cookie, 'x-requested-with': 't' },
      payload: { crossfadeSeconds: 6, eqBands: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    });
    expect(res.json()).toMatchObject({
      crossfadeSeconds: 6,
      eqBands: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    const s = (await get('/me/settings')).json() as UserSettingsDto;
    expect(s.crossfadeSeconds).toBe(6);

    for (const bad of [
      { crossfadeSeconds: 13 },
      { eqBands: [1] },
      { streamQualityWifi: 'ULTRA' },
      { unknown: 1 },
    ]) {
      const r = await t.app.inject({
        method: 'PATCH',
        url: '/api/v1/me/settings',
        headers: { cookie, 'x-requested-with': 't' },
        payload: bad,
      });
      expect(r.statusCode).toBe(400);
    }
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/lib/process.js';
import { artworkFile, THUMB_SIZES } from '../src/modules/library/artwork.js';
import { createTestApp, scanAndWait, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const db = () => t.app.ctx.db;
const abs = (rel: string) => path.join(t.lib.root, rel);
const trackByPath = (rel: string) => db().track.findUniqueOrThrow({ where: { path: rel } });

describe('full scan', () => {
  it('ingests every format with tags, fallbacks and credits', async () => {
    const scan = await scanAndWait(t.app);
    expect(scan).toMatchObject({
      status: 'COMPLETED',
      filesSeen: 5,
      added: 5,
      updated: 0,
      moved: 0,
      errors: [],
    });

    const flac = await db().track.findUniqueOrThrow({
      where: { path: t.lib.files.flac },
      include: { album: { include: { albumArtist: true } }, genres: { include: { genre: true } } },
    });
    expect(flac).toMatchObject({
      title: 'First Song',
      trackNumber: 1,
      year: 2020,
      codec: 'flac',
      lossless: true,
      replayGainDb: -6.5,
      loudnessSource: 'TAG',
    });
    expect(flac.durationMs).toBeGreaterThan(2900);
    expect(flac.album.title).toBe('Tagged Album');
    expect(flac.album.albumArtist.name).toBe('Tagged Artist');
    expect(flac.genres.map((g) => g.genre.name).sort()).toEqual(['Indie', 'Rock']);
    expect(flac.artworkId).not.toBeNull();

    const mp3 = await db().track.findUniqueOrThrow({
      where: { path: t.lib.files.mp3 },
      include: { credits: { include: { artist: true }, orderBy: { position: 'asc' } } },
    });
    expect(mp3.albumId).toBe(flac.albumId);
    // Same embedded cover in both files, processed concurrently: stored once, linked to both.
    expect(mp3.artworkId).toBe(flac.artworkId);
    expect(mp3.credits.map((c) => [c.artist.name, c.role])).toEqual([
      ['Tagged Artist', 'main'],
      ['Guest One', 'featured'],
    ]);

    // Untagged: everything from the path, art from cover.jpg
    const wav = await db().track.findUniqueOrThrow({
      where: { path: t.lib.files.wav },
      include: { album: true, artist: true },
    });
    expect(wav).toMatchObject({
      title: 'Untagged Song',
      trackNumber: 3,
      codec: 'pcm',
      lossless: true,
    });
    expect(wav.artist.name).toBe('Folder Artist');
    expect(wav.album).toMatchObject({ title: 'Folder Album', year: 2018, trackCount: 2 });
    expect(wav.album.artworkId).not.toBeNull();

    const m4a = await db().track.findUniqueOrThrow({
      where: { path: t.lib.files.m4a },
      include: { album: { include: { albumArtist: true } } },
    });
    expect(m4a).toMatchObject({ codec: 'aac', discNumber: 2, trackNumber: 5 });
    expect(m4a.album.isCompilation).toBe(true);
    expect(m4a.album.albumArtist.name).toBe('Various Artists');
  });

  it('writes deduplicated artwork thumbnails', async () => {
    await scanAndWait(t.app);
    const artworks = await db().artwork.findMany();
    // red (embedded in 2 tracks, stored once) + blue folder cover
    expect(artworks).toHaveLength(2);
    for (const a of artworks) {
      for (const v of [...THUMB_SIZES, 'orig'] as const) {
        await expect(fs.access(artworkFile(t.env.DATA_DIR, a.hash, v))).resolves.toBeUndefined();
      }
    }
    const meta = await import('sharp').then((m) =>
      m.default(artworkFile(t.env.DATA_DIR, artworks[0]!.hash, 64)).metadata(),
    );
    expect([meta.width, meta.height, meta.format]).toEqual([64, 64, 'webp']);
  });

  it('is a no-op on rescan when nothing changed', async () => {
    await scanAndWait(t.app);
    const before = await db().track.findMany({ orderBy: { id: 'asc' } });
    const scan = await scanAndWait(t.app);
    expect(scan).toMatchObject({ added: 0, updated: 0, moved: 0, removed: 0 });
    expect(await db().track.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('re-reads a file whose content changed, keeping its id', async () => {
    await scanAndWait(t.app);
    const before = await trackByPath(t.lib.files.flac);
    const tmp = `${abs(t.lib.files.flac)}.tmp.flac`;
    await run('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-i',
      abs(t.lib.files.flac),
      '-map',
      '0',
      '-c',
      'copy',
      '-metadata',
      'title=Renamed Song',
      tmp,
    ]);
    await fs.rename(tmp, abs(t.lib.files.flac));

    const scan = await scanAndWait(t.app);
    expect(scan).toMatchObject({ updated: 1, added: 0 });
    const after = await trackByPath(t.lib.files.flac);
    expect(after.id).toBe(before.id);
    expect(after.title).toBe('Renamed Song');
  });

  it('detects moves by content and keeps the track id', async () => {
    await scanAndWait(t.app);
    const before = await trackByPath(t.lib.files.mp3);
    await fs.mkdir(abs('Elsewhere'), { recursive: true });
    await fs.rename(abs(t.lib.files.mp3), abs('Elsewhere/moved.mp3'));

    const scan = await scanAndWait(t.app);
    expect(scan).toMatchObject({ moved: 1, added: 0, removed: 0 });
    const after = await trackByPath('Elsewhere/moved.mp3');
    expect(after.id).toBe(before.id);
    expect(after.missingSince).toBeNull();
  });

  it('soft-deletes missing files and restores them when they come back', async () => {
    await scanAndWait(t.app);
    const stash = abs('../stash.wav');
    await fs.rename(abs(t.lib.files.wav), stash);
    expect(await scanAndWait(t.app)).toMatchObject({ removed: 1 });
    const missing = await trackByPath(t.lib.files.wav);
    expect(missing.missingSince).not.toBeNull();
    expect(
      (await db().album.findUniqueOrThrow({ where: { id: missing.albumId } })).trackCount,
    ).toBe(1);

    await fs.rename(stash, abs(t.lib.files.wav));
    await scanAndWait(t.app);
    const restored = await trackByPath(t.lib.files.wav);
    expect(restored.id).toBe(missing.id);
    expect(restored.missingSince).toBeNull();
  });

  it('skips an exact duplicate copy and reports it', async () => {
    await scanAndWait(t.app);
    await fs.copyFile(abs(t.lib.files.flac), abs('copy.flac'));
    const scan = await scanAndWait(t.app);
    expect(scan.added).toBe(0);
    expect(scan.errors).toEqual([
      { path: 'copy.flac', message: expect.stringContaining('duplicate of') },
    ]);
    // The collision was resolved with full hashes, which are stored for next time.
    expect((await trackByPath(t.lib.files.flac)).fullHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('treats a quick-hash collision with different content as a new track', async () => {
    // Long WAV, then flip one PCM byte in the middle: same size, head and tail.
    const original = 'Collide/a.wav';
    await fs.mkdir(abs('Collide'));
    await run('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300:duration=5',
      '-c:a',
      'pcm_s16le',
      abs(original),
    ]);
    const bytes = await fs.readFile(abs(original));
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = bytes[mid]! ^ 0xff;
    await fs.writeFile(abs('Collide/b.wav'), bytes);

    const scan = await scanAndWait(t.app);
    expect(scan.errors).toEqual([]);
    const [a, b] = await Promise.all([trackByPath(original), trackByPath('Collide/b.wav')]);
    expect(a.quickHash).toBe(b.quickHash);
    expect(a.id).not.toBe(b.id);
  });

  it('records unreadable files as errors without failing the scan', async () => {
    await fs.writeFile(abs('broken.mp3'), 'this is not audio');
    const scan = await scanAndWait(t.app);
    expect(scan.status).toBe('COMPLETED');
    expect(scan.added).toBe(5);
    expect(scan.errors).toEqual([{ path: 'broken.mp3', message: expect.any(String) }]);
  });

  it('ignores hidden files and non-audio files', async () => {
    await fs.copyFile(abs(t.lib.files.mp3), abs('.hidden.mp3'));
    await fs.writeFile(abs('notes.txt'), 'hi');
    expect(await scanAndWait(t.app)).toMatchObject({ filesSeen: 5, added: 5 });
  });
});

describe('purging missing tracks', () => {
  it('lists missing tracks and purges them with orphan cleanup', async () => {
    await scanAndWait(t.app);
    await fs.rm(abs(t.lib.files.m4a));
    await scanAndWait(t.app);

    const missing = await t.app.ctx.library.listMissing(undefined, 50);
    expect(missing.items.map((m) => m.path)).toEqual([t.lib.files.m4a]);

    const purge = await t.app.ctx.library.purgeMissing(null);
    expect(purge).toMatchObject({ status: 'COMPLETED', removed: 1 });
    expect(await db().track.count()).toBe(4);
    // Its album and now-unreferenced artists are gone too.
    expect(await db().album.findFirst({ where: { title: 'Compilation Hits' } })).toBeNull();
    expect(await db().artist.findFirst({ where: { name: 'Comp Artist' } })).toBeNull();
    expect(await db().genre.findFirst({ where: { name: 'Pop' } })).toBeNull();
  });

  it('never purges present tracks even if their ids are passed', async () => {
    await scanAndWait(t.app);
    const present = await trackByPath(t.lib.files.flac);
    expect(await t.app.ctx.library.purgeMissing([present.id])).toMatchObject({ removed: 0 });
    expect(await db().track.count()).toBe(5);
  });

  it('auto-purges after the grace period only when one is configured', async () => {
    await t.close();
    t = await createTestApp({ MISSING_GRACE_DAYS: '1' });
    await scanAndWait(t.app);
    await fs.rm(abs(t.lib.files.opus));
    await scanAndWait(t.app);
    expect(await db().track.count()).toBe(5);
    await db().track.updateMany({
      where: { missingSince: { not: null } },
      data: { missingSince: new Date(Date.now() - 2 * 86_400_000) },
    });
    await scanAndWait(t.app);
    expect(await db().track.count()).toBe(4);
  });
});

describe('incremental (watcher) scans', () => {
  it('handles a batch with a move, an addition and a deletion', async () => {
    await scanAndWait(t.app);
    const moving = await trackByPath(t.lib.files.flac);
    await fs.mkdir(abs('New Folder'));
    await fs.rename(abs(t.lib.files.flac), abs('New Folder/first.flac'));
    await fs.rm(abs(t.lib.files.opus));
    await run('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=990:duration=1',
      '-metadata',
      'title=Fresh',
      abs('New Folder/fresh.mp3'),
    ]);

    const id = await t.app.ctx.library.scanPaths(
      [abs('New Folder')],
      [abs(t.lib.files.flac), abs(t.lib.files.opus)],
    );
    const scan = await t.app.ctx.library.getScan(id);
    expect(scan).toMatchObject({ status: 'COMPLETED', moved: 1, added: 1, removed: 1, errors: [] });
    expect((await trackByPath('New Folder/first.flac')).id).toBe(moving.id);
    expect((await trackByPath(t.lib.files.opus)).missingSince).not.toBeNull();
  });

  it('marks everything under a removed directory missing', async () => {
    await scanAndWait(t.app);
    await fs.rm(abs('Tagged Artist'), { recursive: true });
    await t.app.ctx.library.scanPaths([], [abs('Tagged Artist')]);
    expect(await db().track.count({ where: { missingSince: { not: null } } })).toBe(2);
  });

  it('picks up changes through the real file watcher', async () => {
    const { LibraryWatcher } = await import('../src/modules/library/watcher.js');
    await scanAndWait(t.app);
    const watcher = new LibraryWatcher(t.lib.root, t.app.ctx.library, t.app.log, {
      polling: false,
      debounceMs: 200,
    });
    await watcher.start();
    try {
      await fs.rm(abs(t.lib.files.wav));
      await expect
        .poll(async () => (await trackByPath(t.lib.files.wav)).missingSince, {
          timeout: 15_000,
          interval: 250,
        })
        .not.toBeNull();
    } finally {
      await watcher.stop();
      await t.app.ctx.library.idle();
    }
  });
});

describe('search index', () => {
  it('indexes visible tracks/albums/artists and drops missing ones', async () => {
    await scanAndWait(t.app);
    const s = t.app.ctx.search;
    expect((await s.tracks.search('secnd sng')).hits.map((h) => h.title)).toEqual(['Second Song']);
    expect((await s.artists.search('guest')).hits.map((h) => h.name)).toEqual(['Guest One']);
    expect((await s.albums.search('folder')).hits.map((h) => h.title)).toEqual(['Folder Album']);

    await fs.rm(abs(t.lib.files.mp3));
    await scanAndWait(t.app);
    expect((await s.tracks.search('second')).hits).toEqual([]);
    // Guest One's only credit is gone, so they drop out of artist search too.
    expect((await s.artists.search('guest')).hits).toEqual([]);
  });

  it('rebuilds the index when it is out of sync', async () => {
    await scanAndWait(t.app);
    const s = t.app.ctx.search;
    const { waitOk } = await import('../src/search/meili.js');
    await waitOk(s.tracks.deleteAllDocuments());
    expect(await t.app.ctx.indexer.needsReindex()).toBe(true);
    await t.app.ctx.indexer.reindexAll();
    expect(await t.app.ctx.indexer.needsReindex()).toBe(false);
  });
});

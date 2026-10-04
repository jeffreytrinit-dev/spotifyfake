import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../src/lib/process.js';

/**
 * Builds a small, deterministic music library with ffmpeg. Covers: tagged FLAC with embedded
 * art + ReplayGain, MP3 with a "feat." credit, untagged WAV/Opus relying on path parsing and a
 * folder cover.jpg, and an M4A compilation inside a disc sub-folder.
 */
export interface FixtureLibrary {
  root: string;
  files: Record<FixtureName, string>;
}

export type FixtureName = 'flac' | 'mp3' | 'wav' | 'opus' | 'm4a';

const ffmpeg = (args: string[]) =>
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 60_000 });

async function image(file: string, color: string): Promise<void> {
  await ffmpeg(['-f', 'lavfi', '-i', `color=${color}:s=500x500`, '-frames:v', '1', file]);
}

function sine(freq: number, seconds = 2): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}:sample_rate=44100`];
}

function meta(tags: Record<string, string | number>): string[] {
  return Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
}

export interface FixtureOptions {
  /**
   * Longer tracks for browser tests (30 s, except "First Song" at 4 s so auto-advance is quick).
   * Default: 2–3 s tracks, which keeps server tests fast.
   */
  long?: boolean;
}

/** Generated once per process and copied per test, since ffmpeg is the slow part. */
const templates = new Map<boolean, Promise<FixtureLibrary>>();

async function buildTemplate({ long = false }: FixtureOptions): Promise<FixtureLibrary> {
  const len = (short: number) => (long ? 30 : short);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tidepool-fixture-'));
  const art = path.join(root, '.art');
  await fs.mkdir(art);
  const red = path.join(art, 'red.png');
  const blue = path.join(art, 'blue.jpg');
  await Promise.all([image(red, 'red'), image(blue, 'blue')]);

  const files: Record<FixtureName, string> = {
    flac: 'Tagged Artist/Tagged Album (2020)/01 - First Song.flac',
    mp3: 'Tagged Artist/Tagged Album (2020)/02 - Second Song.mp3',
    wav: 'Folder Artist/Folder Album (2018)/03 - Untagged Song.wav',
    opus: 'Folder Artist/Folder Album (2018)/04 - Another Untagged.opus',
    m4a: 'Various/Compilation Hits/Disc 2/05 - Comp Song.m4a',
  };
  for (const rel of Object.values(files))
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  const abs = (k: FixtureName) => path.join(root, files[k]);
  const albumTags = { album: 'Tagged Album', album_artist: 'Tagged Artist', date: 2020 };

  await Promise.all([
    ffmpeg([
      ...sine(440, long ? 4 : 3),
      '-i',
      red,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'flac',
      '-c:v',
      'png',
      '-disposition:v',
      'attached_pic',
      ...meta({
        ...albumTags,
        title: 'First Song',
        artist: 'Tagged Artist',
        track: '1/2',
        genre: 'Rock;Indie',
        REPLAYGAIN_TRACK_GAIN: '-6.50 dB',
        REPLAYGAIN_TRACK_PEAK: '0.950000',
      }),
      abs('flac'),
    ]),
    ffmpeg([
      ...sine(550, len(2)),
      '-i',
      red,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-c:v',
      'png',
      '-disposition:v',
      'attached_pic',
      '-id3v2_version',
      '3',
      ...meta({
        ...albumTags,
        title: 'Second Song',
        artist: 'Tagged Artist feat. Guest One',
        track: '2/2',
        genre: 'Rock',
      }),
      abs('mp3'),
    ]),
    ffmpeg([
      ...sine(660, len(2)),
      '-c:a',
      'pcm_s16le',
      '-fflags',
      '+bitexact',
      '-map_metadata',
      '-1',
      abs('wav'),
    ]),
    ffmpeg([
      ...sine(770, len(2)),
      '-c:a',
      'libopus',
      '-b:a',
      '64k',
      '-map_metadata',
      '-1',
      abs('opus'),
    ]),
    ffmpeg([
      ...sine(880, len(2)),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      ...meta({
        title: 'Comp Song',
        artist: 'Comp Artist',
        album: 'Compilation Hits',
        compilation: 1,
        track: 5,
        disc: 2,
        genre: 'Pop',
      }),
      abs('m4a'),
    ]),
  ]);
  await fs.copyFile(blue, path.join(root, 'Folder Artist/Folder Album (2018)/cover.jpg'));
  await fs.rm(art, { recursive: true });
  return { root, files };
}

/** A fresh copy of the fixture library in its own temp dir. */
export async function createFixtureLibrary(opts: FixtureOptions = {}): Promise<FixtureLibrary> {
  const key = opts.long ?? false;
  if (!templates.has(key)) templates.set(key, buildTemplate(opts));
  const t = await templates.get(key)!;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tidepool-lib-'));
  await fs.cp(t.root, root, { recursive: true });
  return { root, files: t.files };
}

/** Write the fixture library to a fixed directory (used by `pnpm fixtures` for manual testing). */
export async function writeFixtureLibrary(dest: string, opts: FixtureOptions = {}): Promise<void> {
  const lib = await createFixtureLibrary(opts);
  await fs.mkdir(dest, { recursive: true });
  await fs.cp(lib.root, dest, { recursive: true });
  await fs.rm(lib.root, { recursive: true });
}

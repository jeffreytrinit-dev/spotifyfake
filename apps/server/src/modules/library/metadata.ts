import path from 'node:path';
import { parseFile, type IAudioMetadata, type IPicture } from 'music-metadata';
import { probeDurationMs } from '../../lib/process.js';
import { parseLibraryPath } from './filename-parser.js';

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
]);

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface ArtistCredit {
  name: string;
  role: 'main' | 'featured';
}

export interface ParsedTrack {
  title: string;
  artistDisplay: string;
  /** Ordered credits; first `main` is the primary artist. Always non-empty. */
  credits: ArtistCredit[];
  albumArtist: string;
  album: string;
  isCompilation: boolean;
  trackNumber: number | null;
  discNumber: number;
  year: number | null;
  genres: string[];
  durationMs: number;
  container: string;
  codec: string;
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  lossless: boolean;
  replayGainDb: number | null;
  replayPeak: number | null;
  albumGainDb: number | null;
  albumPeak: number | null;
  picture: { data: Uint8Array; format: string } | null;
  /** False when tags were unreadable/absent and the result came from the path. */
  fromTags: boolean;
}

export const UNKNOWN_ARTIST = 'Unknown Artist';
export const UNKNOWN_ALBUM = 'Unknown Album';
export const VARIOUS_ARTISTS = 'Various Artists';

const CONTAINER_BY_EXT: Record<string, string> = {
  '.mp3': 'mp3',
  '.flac': 'flac',
  '.m4a': 'mp4',
  '.aac': 'aac',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'ogg',
  '.wav': 'wav',
};

export function normalizeCodec(raw: string | undefined, ext: string): string {
  const c = (raw ?? '').toLowerCase();
  if (c.includes('flac')) return 'flac';
  if (c.includes('layer 3') || c === 'mp3') return 'mp3';
  if (c.includes('alac')) return 'alac';
  if (c.includes('aac') || c.includes('mp4a')) return 'aac';
  if (c.includes('opus')) return 'opus';
  if (c.includes('vorbis')) return 'vorbis';
  if (c.includes('pcm')) return 'pcm';
  // Fall back to what the extension implies.
  return (
    { '.mp3': 'mp3', '.flac': 'flac', '.opus': 'opus', '.wav': 'pcm', '.aac': 'aac' }[ext] ??
    (c || 'unknown')
  );
}

const FEAT_RE = /\s+(?:feat\.?|ft\.?|featuring)\s+/i;
const TITLE_FEAT_RE = /\s*[([](?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]\s*$/i;

function splitList(s: string): string[] {
  return s
    .split(/\s*,\s*|\s+&\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Turn tag values into ordered credits. "&" in the *main* artist is kept intact
 * ("Simon & Garfunkel"); featured lists are split on commas/ampersands.
 */
export function parseCredits(
  artistTag: string | undefined,
  artistsTag: string[] | undefined,
  title: string,
): ArtistCredit[] {
  const credits: ArtistCredit[] = [];
  const add = (name: string, role: ArtistCredit['role']) => {
    const n = name.trim();
    if (n && !credits.some((c) => c.name.toLowerCase() === n.toLowerCase()))
      credits.push({ name: n, role });
  };

  if (artistsTag && artistsTag.length > 1) {
    artistsTag.forEach((a, i) => add(a, i === 0 ? 'main' : 'featured'));
  } else if (artistTag) {
    const [main, ...feat] = artistTag.split(FEAT_RE);
    if (main) add(main, 'main');
    for (const f of feat) splitList(f).forEach((a) => add(a, 'featured'));
  }

  // "Song (feat. X)": credit X but keep the title as tagged.
  const m = TITLE_FEAT_RE.exec(title);
  if (m?.[1]) splitList(m[1]).forEach((a) => add(a, 'featured'));
  return credits;
}

function pickPicture(pictures: IPicture[] | undefined): IPicture | undefined {
  if (!pictures?.length) return undefined;
  return pictures.find((p) => p.type?.toLowerCase().includes('front')) ?? pictures[0];
}

function cleanString(s: string | undefined | null): string | undefined {
  const t = s?.replace(/\0/g, '').trim();
  return t ? t : undefined;
}

function positiveInt(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * Read tags + format for one file, filling gaps from the path. Throws only when the
 * file can't be understood at all (no tags *and* ffprobe can't read a duration).
 */
export async function readTrackMetadata(absPath: string, relPath: string): Promise<ParsedTrack> {
  const ext = path.extname(absPath).toLowerCase();
  const guess = parseLibraryPath(relPath);

  // Corrupt/unknown tags aren't fatal: fall back to the path and ffprobe below.
  const meta: IAudioMetadata | null = await parseFile(absPath, {
    duration: false,
    skipPostHeaders: true,
  }).catch(() => null);
  const common = meta?.common;
  const format = meta?.format;

  let durationMs = format?.duration ? Math.round(format.duration * 1000) : null;
  if (!durationMs) durationMs = await probeDurationMs(absPath);
  if (!durationMs) {
    throw new Error(meta ? 'could not determine duration' : 'unreadable audio file');
  }

  const tagTitle = cleanString(common?.title);
  const rawTitle = tagTitle ?? guess.title;
  const credits = parseCredits(
    cleanString(common?.artist),
    common?.artists?.map((a) => a.trim()).filter(Boolean),
    rawTitle,
  );
  if (credits.length === 0) credits.push({ name: guess.artist ?? UNKNOWN_ARTIST, role: 'main' });

  const isCompilation = common?.compilation === true;
  const albumArtist =
    cleanString(common?.albumartist) ?? (isCompilation ? VARIOUS_ARTISTS : credits[0]!.name);

  const genres = [
    ...new Set(
      (common?.genre ?? [])
        .flatMap((g) => g.split(/\s*;\s*/))
        .map((g) => g.trim())
        .filter(Boolean),
    ),
  ];

  const codec = normalizeCodec(format?.codec, ext);
  const lossless = format?.lossless ?? ['flac', 'alac', 'pcm'].includes(codec);
  const picture = pickPicture(common?.picture);

  return {
    title: rawTitle,
    artistDisplay: cleanString(common?.artist) ?? credits.map((c) => c.name).join(', '),
    credits,
    albumArtist,
    album: cleanString(common?.album) ?? guess.album ?? UNKNOWN_ALBUM,
    isCompilation,
    trackNumber: positiveInt(common?.track.no) ?? guess.trackNumber ?? null,
    discNumber: positiveInt(common?.disk.no) ?? guess.discNumber ?? 1,
    year: positiveInt(common?.year) ?? guess.year ?? null,
    genres,
    durationMs,
    container: CONTAINER_BY_EXT[ext] ?? (format?.container?.toLowerCase() || ext.slice(1)),
    codec,
    bitrate: positiveInt(format?.bitrate),
    sampleRate: positiveInt(format?.sampleRate),
    bitDepth: positiveInt(format?.bitsPerSample),
    channels: positiveInt(format?.numberOfChannels),
    lossless,
    replayGainDb: common?.replaygain_track_gain?.dB ?? null,
    replayPeak: common?.replaygain_track_peak?.ratio ?? null,
    albumGainDb: common?.replaygain_album_gain?.dB ?? null,
    albumPeak: common?.replaygain_album_peak?.ratio ?? null,
    picture: picture ? { data: picture.data, format: picture.format } : null,
    fromTags: Boolean(tagTitle || common?.artist || common?.album),
  };
}

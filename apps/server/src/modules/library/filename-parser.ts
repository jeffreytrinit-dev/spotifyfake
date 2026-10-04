/**
 * Best-effort metadata from a library-relative path, used when tags are missing.
 *
 * Understood layouts (any subset):
 *   Artist/Album/01 - Title.ext
 *   Artist/Album (2019)/01. Title.ext        Artist/2019 - Album/1-01 Title.ext
 *   Artist/Album/CD2/03 Title.ext            Artist/Album [Disc 2]/03 - Title.ext
 *   Album/01 - Artist - Title.ext            Artist - Title.ext
 */
export interface PathGuess {
  title: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
}

const YEAR_RE = /^(19|20)\d{2}$/;
const DISC_DIR_RE = /^(?:cd|disc|disk)\s*[-_ ]?\s*(\d{1,2})$/i;
const DISC_SUFFIX_RE = /\s*[[(]\s*(?:cd|disc|disk)\s*(\d{1,2})\s*[\])]\s*$/i;

function parseYearDecoratedAlbum(dir: string): { album: string; year?: number } {
  // "Album (2019)" / "Album [2019]"
  let m = /^(.*?)\s*[[(]((?:19|20)\d{2})[\])]\s*$/.exec(dir);
  if (m?.[1]) return { album: m[1].trim(), year: Number(m[2]) };
  // "2019 - Album" / "[2019] Album" / "(2019) Album"
  m = /^[[(]?((?:19|20)\d{2})[\])]?\s*(?:[-–.]\s*)?(.+)$/.exec(dir);
  if (m?.[2] && !YEAR_RE.test(dir)) return { album: m[2].trim(), year: Number(m[1]) };
  return { album: dir.trim() };
}

function parseFileStem(
  stem: string,
): Pick<PathGuess, 'trackNumber' | 'discNumber'> & { rest: string } {
  let rest = stem.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const out: Pick<PathGuess, 'trackNumber' | 'discNumber'> = {};

  // "1-01 Title" / "1.01 - Title" (disc-track)
  let m = /^(\d{1,2})[-.](\d{1,3})(?:\s*[-.]\s*|\s+)(.+)$/.exec(rest);
  if (m?.[3]) {
    out.discNumber = Number(m[1]);
    out.trackNumber = Number(m[2]);
    rest = m[3];
  } else {
    // "01 - Title" / "01. Title" / "01 Title" / "1 - Title", but not "99 Luftballons"
    m = /^(\d{1,3})(\s*[-.]\s*|\s+)(.+)$/.exec(rest);
    if (m?.[3] && (m[1]!.length >= 2 || m[2]!.trim() !== '')) {
      out.trackNumber = Number(m[1]);
      rest = m[3];
    }
  }
  return { ...out, rest: rest.trim() || stem };
}

/** Split "Artist - Title" on a spaced dash only, so "Jay-Z" survives. */
function splitArtistTitle(s: string): [string, string] | null {
  const parts = s.split(/\s+[-–]\s+/);
  if (parts.length < 2) return null;
  const title = parts.slice(1).join(' - ').trim();
  return parts[0]!.trim() && title ? [parts[0]!.trim(), title] : null;
}

export function parseLibraryPath(relPath: string): PathGuess {
  const segments = relPath.split('/').filter(Boolean);
  const file = segments.pop() ?? relPath;
  const stem = file.replace(/\.[^.]+$/, '');
  const { rest, ...numbers } = parseFileStem(stem);
  const guess: PathGuess = { title: rest, ...numbers };

  let dirs = [...segments];
  // Disc sub-folder: "CD2", "Disc 1"
  const last = dirs.at(-1);
  const discDir = last ? DISC_DIR_RE.exec(last) : null;
  if (discDir) {
    guess.discNumber ??= Number(discDir[1]);
    dirs = dirs.slice(0, -1);
  }

  const albumDir = dirs.at(-1);
  if (albumDir) {
    let dir = albumDir;
    const discSuffix = DISC_SUFFIX_RE.exec(dir);
    if (discSuffix) {
      guess.discNumber ??= Number(discSuffix[1]);
      dir = dir.slice(0, discSuffix.index);
    }
    const { album, year } = parseYearDecoratedAlbum(dir);
    // A folder that is "Artist - Album" carries both.
    const artistAlbum = album.split(/\s+[-–]\s+/);
    if (artistAlbum.length === 2 && dirs.length === 1) {
      guess.artist ??= artistAlbum[0]!.trim();
      guess.album = artistAlbum[1]!.trim();
    } else {
      guess.album = album;
    }
    if (year !== undefined) guess.year = year;
  }

  const artistDir = dirs.at(-2)?.trim();
  if (artistDir) guess.artist ??= artistDir;

  // "Artist - Title" in the file name. With a folder artist, only strip the prefix when it
  // repeats that artist; otherwise "Song - Live Version" would be mis-split.
  const split = splitArtistTitle(rest);
  if (split) {
    const [fileArtist, title] = split;
    if (guess.artist === undefined) {
      guess.artist = fileArtist;
      guess.title = title;
    } else if (fileArtist.toLowerCase() === guess.artist.toLowerCase()) {
      guess.title = title;
    }
  }

  return guess;
}

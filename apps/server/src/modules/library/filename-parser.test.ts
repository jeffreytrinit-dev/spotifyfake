import { describe, expect, it } from 'vitest';
import { parseLibraryPath } from './filename-parser.js';

describe('parseLibraryPath', () => {
  it.each([
    [
      'Artist/Album/01 - Title.flac',
      { artist: 'Artist', album: 'Album', trackNumber: 1, title: 'Title' },
    ],
    [
      'Artist/Album (2019)/01. Title.mp3',
      { artist: 'Artist', album: 'Album', year: 2019, trackNumber: 1, title: 'Title' },
    ],
    [
      'Artist/[2019] Album/03 Title.mp3',
      { album: 'Album', year: 2019, trackNumber: 3, title: 'Title' },
    ],
    [
      'Artist/2019 - Album/1-04 Title.flac',
      { album: 'Album', year: 2019, discNumber: 1, trackNumber: 4 },
    ],
    [
      'Artist/Album/CD2/07 - Title.flac',
      { artist: 'Artist', album: 'Album', discNumber: 2, trackNumber: 7 },
    ],
    ['Artist/Album [Disc 3]/01 - Title.flac', { album: 'Album', discNumber: 3 }],
    [
      'Artist - Album/02 - Title.ogg',
      { artist: 'Artist', album: 'Album', trackNumber: 2, title: 'Title' },
    ],
    ['Loose Artist - Loose Title.mp3', { artist: 'Loose Artist', title: 'Loose Title' }],
    ['some_file_name.wav', { title: 'some file name' }],
  ])('%s', (input, expected) => {
    expect(parseLibraryPath(input)).toMatchObject(expected);
  });

  it('does not split a title containing a dash when the folder gives the artist', () => {
    expect(parseLibraryPath('Band/Album/05 - Song - Live Version.flac')).toMatchObject({
      artist: 'Band',
      title: 'Song - Live Version',
      trackNumber: 5,
    });
  });

  it('strips a repeated artist prefix from the file name', () => {
    expect(parseLibraryPath('Band/Album/01 - Band - Song.flac')).toMatchObject({
      artist: 'Band',
      title: 'Song',
    });
  });

  it('keeps hyphenated names intact', () => {
    expect(parseLibraryPath('Jay-Z/Album/01 - Track.mp3')).toMatchObject({
      artist: 'Jay-Z',
      title: 'Track',
    });
  });

  it('does not treat a year-only folder as album-with-year', () => {
    expect(parseLibraryPath('Artist/1999/01 - Title.mp3')).toMatchObject({ album: '1999' });
  });
});

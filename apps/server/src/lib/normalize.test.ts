import { describe, expect, it } from 'vitest';
import { albumKey, nameKey, sortName } from './normalize.js';

describe('nameKey', () => {
  it('folds case, accents, leading "The" and punctuation', () => {
    expect(nameKey('The Beatles')).toBe(nameKey('beatles'));
    expect(nameKey('Björk')).toBe(nameKey('Bjork'));
    expect(nameKey('AC/DC')).toBe(nameKey('AC DC'));
    expect(nameKey('Simon & Garfunkel')).toBe(nameKey('Simon and Garfunkel'));
  });

  it('keeps names made only of punctuation distinct', () => {
    expect(nameKey('!!!')).toBe('!!!');
    expect(nameKey('!!!')).not.toBe(nameKey('?'));
  });

  it('keeps non-Latin scripts', () => {
    expect(nameKey('坂本龍一')).toBe('坂本龍一');
  });
});

describe('sortName', () => {
  it('drops leading articles', () => {
    expect(sortName('The Cure')).toBe('Cure');
    expect(sortName('A Tribe Called Quest')).toBe('Tribe Called Quest');
    expect(sortName('The')).toBe('The');
  });
});

describe('albumKey', () => {
  it('is stable across cosmetic differences and distinct per artist', () => {
    expect(albumKey('The Band', 'Album')).toBe(albumKey('band', 'ALBUM'));
    expect(albumKey('Band A', 'Greatest Hits')).not.toBe(albumKey('Band B', 'Greatest Hits'));
  });
});

import { sha256 } from './hash.js';

/**
 * Normalisation key used to dedupe artists/albums/genres that differ only in
 * case, accents, punctuation spacing or a leading "The".
 *   "The Beatles" == "beatles" == "Beatles " ; "Björk" == "Bjork"
 */
export function nameKey(name: string): string {
  const key = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  // Names made only of punctuation ("!!!", "?") would all collapse to "".
  return key || name.trim().toLowerCase();
}

/** Sort form: strips leading articles so "The Cure" sorts under C. */
export function sortName(name: string): string {
  return name.replace(/^(the|a|an)\s+/i, '').trim() || name;
}

export function albumKey(albumArtist: string, title: string): string {
  return sha256(`${nameKey(albumArtist)}\u0000${nameKey(title)}`);
}

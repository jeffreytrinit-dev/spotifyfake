import { describe, expect, it } from 'vitest';
import { parseRange } from './range.js';

describe('parseRange', () => {
  const size = 1000;
  it.each([
    [undefined, null],
    ['bytes=0-1', { start: 0, end: 1 }], // Safari's probe
    ['bytes=0-', { start: 0, end: 999 }],
    ['bytes=500-', { start: 500, end: 999 }],
    ['bytes=990-2000', { start: 990, end: 999 }], // end clamped
    ['bytes=-100', { start: 900, end: 999 }], // suffix
    ['bytes=-5000', { start: 0, end: 999 }],
    ['Bytes=10-20', { start: 10, end: 20 }],
    ['bytes=1000-', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=20-10', null], // invalid → ignored
    ['bytes=0-1,5-6', null], // multipart → ignored, full body
    ['items=0-1', null],
    ['bytes=-', null],
    ['garbage', null],
  ])('%s', (header, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it('treats any range on an empty file as unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-1', 0)).toBe('unsatisfiable');
  });
});

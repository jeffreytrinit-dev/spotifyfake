import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PathTraversalError,
  resolveInside,
  resolveRealInside,
  toLibraryPath,
} from './safe-path.js';

describe('resolveInside', () => {
  const root = path.resolve('/music');

  it('resolves normal relative paths', () => {
    expect(resolveInside(root, 'A/B/c.flac')).toBe(path.join(root, 'A/B/c.flac'));
  });

  it.each(['../etc/passwd', 'A/../../etc/passwd', '/etc/passwd', 'C:\\Windows', 'a\0b'])(
    'rejects %j',
    (input) => {
      expect(() => resolveInside(root, input)).toThrow(PathTraversalError);
    },
  );

  it('allows names that merely start with dots', () => {
    expect(resolveInside(root, '..hidden/x.mp3')).toBe(path.join(root, '..hidden/x.mp3'));
  });
});

describe('resolveRealInside', () => {
  let root: string;
  let outside: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-root-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-out-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
    await fs.writeFile(path.join(root, 'ok.mp3'), 'x');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.mp3'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true });
    await fs.rm(outside, { recursive: true });
  });

  it('accepts real files inside the root', async () => {
    await expect(resolveRealInside(root, 'ok.mp3')).resolves.toBe(
      await fs.realpath(path.join(root, 'ok.mp3')),
    );
  });

  it('rejects symlinks pointing outside the root', async () => {
    await expect(resolveRealInside(root, 'link.mp3')).rejects.toBeInstanceOf(PathTraversalError);
  });
});

describe('toLibraryPath', () => {
  it('produces POSIX relative paths', () => {
    expect(toLibraryPath('/music', '/music/A/b.mp3')).toBe('A/b.mp3');
  });
  it('refuses paths outside the root', () => {
    expect(() => toLibraryPath('/music', '/other/b.mp3')).toThrow(PathTraversalError);
  });
});

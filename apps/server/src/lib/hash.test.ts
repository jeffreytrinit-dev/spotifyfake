import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUICK_HASH_CHUNK, hashFile, quickHashFile } from './hash.js';

describe('quickHashFile', () => {
  let dir: string;
  const write = async (name: string, data: Buffer) => {
    const p = path.join(dir, name);
    await fs.writeFile(p, data);
    return p;
  };
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-'));
  });
  afterAll(() => fs.rm(dir, { recursive: true }));

  it('is identical for identical content and differs for different small files', async () => {
    const a = await write('a', Buffer.from('hello'));
    const b = await write('b', Buffer.from('hello'));
    const c = await write('c', Buffer.from('hellp'));
    expect(await quickHashFile(a, 5)).toBe(await quickHashFile(b, 5));
    expect(await quickHashFile(a, 5)).not.toBe(await quickHashFile(c, 5));
  });

  it('only looks at size + head + tail for large files (full hash tells them apart)', async () => {
    const size = QUICK_HASH_CHUNK * 4;
    const base = Buffer.alloc(size, 1);
    const changedMiddle = Buffer.from(base);
    changedMiddle[size / 2] = 2;
    const changedTail = Buffer.from(base);
    changedTail[size - 1] = 2;
    const [p1, p2, p3] = await Promise.all([
      write('l1', base),
      write('l2', changedMiddle),
      write('l3', changedTail),
    ]);

    expect(await quickHashFile(p1, size)).toBe(await quickHashFile(p2, size));
    expect(await hashFile(p1)).not.toBe(await hashFile(p2));
    expect(await quickHashFile(p1, size)).not.toBe(await quickHashFile(p3, size));
  });

  it('includes the size', async () => {
    const size = QUICK_HASH_CHUNK * 3;
    const p = await write('s', Buffer.alloc(size, 7));
    expect(await quickHashFile(p, size)).not.toBe(await quickHashFile(p, size + 1));
  });
});

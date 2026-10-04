import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

/** Streaming SHA-256 of a file, hex encoded. Constant memory regardless of file size. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1 << 20 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export const QUICK_HASH_CHUNK = 64 * 1024;

/**
 * Cheap content fingerprint: SHA-256 over the file size plus its first and last 64 KiB.
 * Reads at most 128 KiB regardless of file size, so rescans of large FLAC libraries stay
 * fast on a Pi. Audio payload differences almost always show up in those windows; when
 * two files do share a quick hash, callers fall back to `hashFile` to decide.
 */
export async function quickHashFile(filePath: string, size: number): Promise<string> {
  const hash = createHash('sha256').update(`${size}:`);
  const handle = await open(filePath, 'r');
  try {
    if (size <= QUICK_HASH_CHUNK * 2) {
      hash.update(await handle.readFile());
    } else {
      const buf = Buffer.alloc(QUICK_HASH_CHUNK);
      const head = await handle.read(buf, 0, QUICK_HASH_CHUNK, 0);
      hash.update(buf.subarray(0, head.bytesRead));
      const tail = await handle.read(buf, 0, QUICK_HASH_CHUNK, size - QUICK_HASH_CHUNK);
      hash.update(buf.subarray(0, tail.bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

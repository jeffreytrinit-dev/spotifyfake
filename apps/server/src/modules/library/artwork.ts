import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db.js';
import { isUniqueViolation } from '../../db.js';
import type { ArtworkSource } from '../../generated/prisma/enums.js';
import { sha256 } from '../../lib/hash.js';

export const THUMB_SIZES = [64, 300, 640] as const;
export type ArtVariant = (typeof THUMB_SIZES)[number] | 'orig';

const ORIG_MAX = 1200;
const MAX_FOLDER_IMAGE_BYTES = 30 << 20;
const FOLDER_ART_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const FOLDER_ART_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

export function artworkFile(dataDir: string, hash: string, variant: ArtVariant): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid artwork hash');
  return path.join(dataDir, 'art', hash.slice(0, 2), `${hash}_${variant}.webp`);
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/**
 * Stores images once per content hash and renders WebP variants. Holds a per-instance
 * hash → id cache so an album whose 15 tracks embed the same cover is decoded only once.
 */
export class ArtworkStore {
  /** In-flight and finished ingests, so concurrent tracks sharing a cover decode it once. */
  private readonly idByHash = new Map<string, Promise<string | null>>();
  private readonly folderArt = new Map<string, Promise<string | null>>();

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Forget per-scan caches (call between scans so deleted art is re-created). */
  reset(): void {
    this.idByHash.clear();
    this.folderArt.clear();
  }

  async ingest(data: Uint8Array, source: ArtworkSource): Promise<string | null> {
    const hash = sha256(data);
    let pending = this.idByHash.get(hash);
    if (!pending) {
      pending = this.ingestUncached(Buffer.from(data), hash, source).catch((err: unknown) => {
        this.log.warn({ err, hash }, 'artwork: failed to process image');
        return null;
      });
      this.idByHash.set(hash, pending);
    }
    return pending;
  }

  private async ingestUncached(buf: Buffer, hash: string, source: ArtworkSource): Promise<string> {
    const existing = await this.db.artwork.findUnique({ where: { hash } });
    if (existing && (await this.variantsExist(hash))) return existing.id;

    const base = sharp(buf, { failOn: 'error' }).rotate();
    const meta = await base.metadata();
    if (!meta.width || !meta.height) throw new Error('image has no dimensions');

    const [orig, stats, ...thumbs] = await Promise.all([
      base
        .clone()
        .resize(ORIG_MAX, ORIG_MAX, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer(),
      base.clone().stats(),
      ...THUMB_SIZES.map((size) =>
        base
          .clone()
          .resize(size, size, { fit: 'cover', position: 'attention' })
          .webp({ quality: 80 })
          .toBuffer(),
      ),
    ]);
    await writeAtomic(artworkFile(this.dataDir, hash, 'orig'), orig);
    await Promise.all(
      THUMB_SIZES.map((size, i) => writeAtomic(artworkFile(this.dataDir, hash, size), thumbs[i]!)),
    );

    const { r, g, b } = stats.dominant;
    const dominantColor = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    const data = { hash, source, width: meta.width, height: meta.height, dominantColor };
    if (existing) return existing.id;
    try {
      return (await this.db.artwork.create({ data })).id;
    } catch (err) {
      // Another concurrent ingest of the same image won the race.
      if (!isUniqueViolation(err)) throw err;
      return (await this.db.artwork.findUniqueOrThrow({ where: { hash } })).id;
    }
  }

  private async variantsExist(hash: string): Promise<boolean> {
    try {
      await Promise.all(
        (['orig', ...THUMB_SIZES] as const).map((v) =>
          fs.access(artworkFile(this.dataDir, hash, v)),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** `cover.jpg`, `folder.png`, … in the given directory, ingested once per directory per scan. */
  folderArtwork(absDir: string): Promise<string | null> {
    let pending = this.folderArt.get(absDir);
    if (!pending) {
      pending = this.findFolderImage(absDir).then(async (file) => {
        if (!file) return null;
        const stat = await fs.stat(file);
        if (stat.size > MAX_FOLDER_IMAGE_BYTES) return null;
        return this.ingest(await fs.readFile(file), 'FOLDER');
      });
      pending = pending.catch((err: unknown) => {
        this.log.warn({ err, dir: absDir }, 'artwork: failed to read folder image');
        return null;
      });
      this.folderArt.set(absDir, pending);
    }
    return pending;
  }

  private async findFolderImage(absDir: string): Promise<string | null> {
    let entries: string[];
    try {
      entries = await fs.readdir(absDir);
    } catch {
      return null;
    }
    const candidates = entries
      .map((name) => {
        const ext = path.extname(name).toLowerCase();
        const stem = path.basename(name, path.extname(name)).toLowerCase();
        return { name, rank: FOLDER_ART_NAMES.indexOf(stem), ext };
      })
      .filter((c) => c.rank >= 0 && FOLDER_ART_EXTS.includes(c.ext))
      .sort((a, b) => a.rank - b.rank);
    return candidates[0] ? path.join(absDir, candidates[0].name) : null;
  }
}

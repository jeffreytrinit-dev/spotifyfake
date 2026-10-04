import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';

export class PathTraversalError extends AppError {
  constructor() {
    super(400, 'INVALID_PATH', 'Path escapes its root directory');
  }
}

/** True if `candidate` is `root` or below it. Compares segments, so "..hidden" is fine. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Resolve `relative` against `root`, refusing anything that would land outside it
 * (`..` segments, absolute paths, NUL bytes). Purely lexical — see `resolveRealInside`
 * when symlinks must also be contained.
 */
export function resolveInside(root: string, relative: string): string {
  if (relative.includes('\0')) throw new PathTraversalError();
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new PathTraversalError();
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, relative);
  if (!isInside(absRoot, resolved)) throw new PathTraversalError();
  return resolved;
}

/** Like `resolveInside`, but also follows symlinks and checks the real target stays inside root. */
export async function resolveRealInside(root: string, relative: string): Promise<string> {
  const lexical = resolveInside(root, relative);
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(lexical)]);
  if (!isInside(realRoot, realTarget)) throw new PathTraversalError();
  return realTarget;
}

/** Convert an absolute path under `root` into the POSIX-style relative form stored in the DB. */
export function toLibraryPath(root: string, absolute: string): string {
  const rel = path.relative(path.resolve(root), absolute);
  if (!isInside(path.resolve(root), absolute)) throw new PathTraversalError();
  return rel.split(path.sep).join('/');
}

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Parse a `Range` header for a resource of `size` bytes (RFC 9110 §14).
 * Returns the range to serve, `'unsatisfiable'` (→ 416), or `null` to ignore the header and
 * send the whole body (missing/malformed header, other units, or multiple ranges, which media
 * players don't use; ignoring them is allowed by the spec).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim());
  if (!m) return null;
  const [, startStr = '', endStr = ''] = m;
  if (startStr === '' && endStr === '') return null;

  if (startStr === '') {
    // Suffix range: last N bytes.
    const suffix = Number(endStr);
    if (suffix === 0) return 'unsatisfiable';
    if (size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startStr);
  if (start >= size) return 'unsatisfiable';
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  if (end < start) return null; // syntactically invalid → ignore
  return { start, end };
}

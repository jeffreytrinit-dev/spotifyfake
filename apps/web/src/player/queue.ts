/**
 * The play queue as pure functions over a serialisable snapshot (the same shape the server
 * stores). Three lists drive it:
 *   upNext  – what you added with "Play next" / "Add to queue"; always plays first
 *   later   – the rest of the album/playlist, in play order (shuffled or natural)
 *   history – what already played, oldest first
 * Shuffle is a true shuffle: a fresh permutation of the remaining tracks, so nothing repeats
 * until every track in the context has played.
 */
import type { PlayContext, QueueEntry, QueueSnapshot, RepeatMode } from '@tidepool/shared';

export type QueueState = QueueSnapshot;
export type Rng = () => number;

export const HISTORY_LIMIT = 100;

export function makeUid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function emptyQueue(): QueueState {
  return {
    context: null,
    source: [],
    current: null,
    upNext: [],
    later: [],
    history: [],
    shuffle: false,
    repeat: 'off',
  };
}

const entry = (trackId: string, origin: QueueEntry['origin']): QueueEntry => ({
  uid: makeUid(),
  trackId,
  origin,
});
const fresh = (e: QueueEntry): QueueEntry => ({ ...e, uid: makeUid() });

export function shuffled<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function pushHistory(history: QueueEntry[], e: QueueEntry | null): QueueEntry[] {
  if (!e) return history;
  const next = [...history, e];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** Start playing a context (album, playlist…). `startIndex` null = random start when shuffling, else first. */
export function playContext(
  q: QueueState,
  context: PlayContext,
  trackIds: readonly string[],
  startIndex: number | null,
  opts: { shuffle?: boolean; rng?: Rng } = {},
): QueueState {
  if (!trackIds.length) return q;
  const rng = opts.rng ?? Math.random;
  const shuffle = opts.shuffle ?? q.shuffle;
  const source = trackIds.map((id) => entry(id, 'context'));
  const start =
    startIndex !== null
      ? Math.min(Math.max(startIndex, 0), source.length - 1)
      : shuffle
        ? Math.floor(rng() * source.length)
        : 0;
  const current = source[start]!;
  const rest = source.filter((_, i) => i !== start);
  return {
    ...q,
    context,
    source,
    current: fresh(current),
    later: shuffle ? shuffled(rest, rng).map(fresh) : source.slice(start + 1).map(fresh),
    history: pushHistory(q.history, q.current),
    shuffle,
  };
}

/** A new pass over the whole context for repeat-all. A shuffled pass never starts with the track that just played. */
function newCycle(q: QueueState, rng: Rng): QueueEntry[] {
  if (!q.shuffle) return q.source.map(fresh);
  const cycle = shuffled(q.source, rng).map(fresh);
  if (cycle.length > 1 && cycle[0]!.trackId === q.current?.trackId) {
    [cycle[0], cycle[1]] = [cycle[1]!, cycle[0]!];
  }
  return cycle;
}

export interface AdvanceResult {
  queue: QueueState;
  /** True when there was nothing left to play; the queue is unchanged and playback should stop. */
  ended: boolean;
  /** Same entry again (repeat-one on natural end): restart it. */
  repeatedCurrent: boolean;
}

/** Move to the next track. `auto` = the current track finished by itself (repeat-one applies). */
export function advance(
  q: QueueState,
  { auto = false, rng = Math.random }: { auto?: boolean; rng?: Rng } = {},
): AdvanceResult {
  if (auto && q.repeat === 'one' && q.current)
    return { queue: q, ended: false, repeatedCurrent: true };
  const history = pushHistory(q.history, q.current);
  if (q.upNext.length) {
    return {
      queue: { ...q, history, current: q.upNext[0]!, upNext: q.upNext.slice(1) },
      ended: false,
      repeatedCurrent: false,
    };
  }
  if (q.later.length) {
    return {
      queue: { ...q, history, current: q.later[0]!, later: q.later.slice(1) },
      ended: false,
      repeatedCurrent: false,
    };
  }
  if (q.repeat !== 'off' && q.source.length) {
    const cycle = newCycle(q, rng);
    return {
      queue: { ...q, history, current: cycle[0]!, later: cycle.slice(1) },
      ended: false,
      repeatedCurrent: false,
    };
  }
  return { queue: q, ended: true, repeatedCurrent: false };
}

/**
 * The entry `advance({ auto: true })` would play next, for preloading. Null at the end of the
 * queue, and at a repeat-all wrap-around with shuffle (that order is decided when it happens).
 */
export function peekNext(q: QueueState): QueueEntry | null {
  if (q.repeat === 'one') return q.current;
  if (q.upNext[0]) return q.upNext[0];
  if (q.later[0]) return q.later[0];
  if (q.repeat === 'all' && !q.shuffle) return q.source[0] ?? null;
  return null;
}

/** Go back to the previously played track, or null if there is none. */
export function back(q: QueueState): QueueState | null {
  const prev = q.history.at(-1);
  if (!prev) return null;
  const history = q.history.slice(0, -1);
  if (!q.current) return { ...q, history, current: prev };
  const cur = q.current;
  return cur.origin === 'queue'
    ? { ...q, history, current: prev, upNext: [cur, ...q.upNext] }
    : { ...q, history, current: prev, later: [cur, ...q.later] };
}

export function setShuffle(q: QueueState, on: boolean, rng: Rng = Math.random): QueueState {
  if (on === q.shuffle) return q;
  if (on) return { ...q, shuffle: true, later: shuffled(q.later, rng) };
  // Back to album order, continuing after the last context track that played.
  const anchor =
    q.current?.origin === 'context'
      ? q.current
      : [...q.history].reverse().find((e) => e.origin === 'context');
  const idx = anchor ? q.source.findIndex((e) => e.trackId === anchor.trackId) : -1;
  return { ...q, shuffle: false, later: q.source.slice(idx + 1).map(fresh) };
}

export function setRepeat(q: QueueState, repeat: RepeatMode): QueueState {
  return { ...q, repeat };
}

export function cycleRepeat(q: QueueState): QueueState {
  const order: RepeatMode[] = ['off', 'all', 'one'];
  return setRepeat(q, order[(order.indexOf(q.repeat) + 1) % order.length]!);
}

export function playNext(q: QueueState, trackIds: readonly string[]): QueueState {
  return { ...q, upNext: [...trackIds.map((id) => entry(id, 'queue')), ...q.upNext] };
}

export function addToQueue(q: QueueState, trackIds: readonly string[]): QueueState {
  return { ...q, upNext: [...q.upNext, ...trackIds.map((id) => entry(id, 'queue'))] };
}

export function removeUpcoming(q: QueueState, uid: string): QueueState {
  return {
    ...q,
    upNext: q.upNext.filter((e) => e.uid !== uid),
    later: q.later.filter((e) => e.uid !== uid),
  };
}

export function clearUpNext(q: QueueState): QueueState {
  return { ...q, upNext: [] };
}

/** Upcoming entries in play order, as the queue screen shows them. */
export function upcoming(q: QueueState): QueueEntry[] {
  return [...q.upNext, ...q.later];
}

/**
 * Drag-and-drop: put `fromUid` where `overUid` is. The moved entry joins the section it was
 * dropped into, so dragging an album track into "Next in queue" makes it a queued track.
 */
export function moveUpcoming(q: QueueState, fromUid: string, overUid: string): QueueState {
  if (fromUid === overUid) return q;
  const all = upcoming(q);
  const from = all.findIndex((e) => e.uid === fromUid);
  const over = all.findIndex((e) => e.uid === overUid);
  if (from < 0 || over < 0) return q;
  const target = all[over]!;
  const moved: QueueEntry = { ...all[from]!, origin: target.origin };
  const rest = all.filter((_, i) => i !== from);
  rest.splice(over, 0, moved);
  return {
    ...q,
    upNext: rest.filter((e) => e.origin === 'queue'),
    later: rest.filter((e) => e.origin === 'context'),
  };
}

/** Play an upcoming entry now. Queued entries before it are dropped; album tracks before it are skipped. */
export function jumpTo(q: QueueState, uid: string): QueueState {
  const history = pushHistory(q.history, q.current);
  const qi = q.upNext.findIndex((e) => e.uid === uid);
  if (qi >= 0) return { ...q, history, current: q.upNext[qi]!, upNext: q.upNext.slice(qi + 1) };
  const li = q.later.findIndex((e) => e.uid === uid);
  if (li >= 0) return { ...q, history, current: q.later[li]!, later: q.later.slice(li + 1) };
  return q;
}

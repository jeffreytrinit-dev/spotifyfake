import { describe, expect, it } from 'vitest';
import type { PlayContext } from '@tidepool/shared';
import {
  addToQueue,
  advance,
  back,
  clearUpNext,
  cycleRepeat,
  emptyQueue,
  jumpTo,
  moveUpcoming,
  peekNext,
  playContext,
  playNext,
  removeUpcoming,
  setRepeat,
  setShuffle,
  upcoming,
  type QueueState,
} from './queue.js';

const album: PlayContext = { type: 'album', id: 'album1', name: 'Album' };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`.padEnd(20, 'x'));
const T = ids(5);
const tids = (es: { trackId: string }[]) => es.map((e) => e.trackId);

/** Deterministic PRNG (mulberry32) so shuffle tests are reproducible. */
function rng(seed = 1) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Play through the whole queue with auto-advance, returning the track ids in order. */
function drain(q: QueueState, max = 100): string[] {
  const played = [q.current!.trackId];
  for (let i = 0; i < max; i++) {
    const r = advance(q, { auto: true });
    if (r.ended) break;
    q = r.queue;
    played.push(q.current!.trackId);
  }
  return played;
}

describe('playContext', () => {
  it('starts at the chosen track and continues in album order', () => {
    const q = playContext(emptyQueue(), album, T, 2);
    expect(q.current!.trackId).toBe(T[2]);
    expect(tids(q.later)).toEqual([T[3], T[4]]);
    expect(drain(q)).toEqual([T[2], T[3], T[4]]);
  });

  it('keeps the user queue and records the previous track in history', () => {
    let q = playContext(emptyQueue(), album, T, 0);
    q = addToQueue(q, ['q1'.padEnd(20, 'x')]);
    q = playContext(q, { ...album, id: 'album2' }, ids(2), 0);
    expect(tids(q.upNext)).toEqual(['q1'.padEnd(20, 'x')]);
    expect(tids(q.history)).toEqual([T[0]]);
  });

  it('ignores an empty context', () => {
    const q = emptyQueue();
    expect(playContext(q, album, [], 0)).toBe(q);
  });
});

describe('true shuffle', () => {
  it('plays every track exactly once before the queue ends', () => {
    const many = ids(30);
    const q = playContext(emptyQueue(), album, many, null, { shuffle: true, rng: rng(7) });
    const played = drain(q);
    expect(played).toHaveLength(30);
    expect(new Set(played).size).toBe(30);
    expect(played).not.toEqual(many); // overwhelmingly unlikely to be in order
  });

  it('starts at the chosen track when one is given', () => {
    const q = playContext(emptyQueue(), album, T, 3, { shuffle: true, rng: rng(2) });
    expect(q.current!.trackId).toBe(T[3]);
    expect(tids(q.later).sort()).toEqual([T[0], T[1], T[2], T[4]].sort());
  });

  it('with repeat-all, each pass is a full permutation and never repeats the boundary track', () => {
    let q = setRepeat(
      playContext(emptyQueue(), album, T, null, { shuffle: true, rng: rng(3) }),
      'all',
    );
    const played: string[] = [q.current!.trackId];
    for (let i = 0; i < 5 * 20 - 1; i++) {
      q = advance(q, { auto: true, rng: rng(i + 10) }).queue;
      played.push(q.current!.trackId);
    }
    for (let pass = 0; pass < 20; pass++) {
      expect(new Set(played.slice(pass * 5, pass * 5 + 5)).size).toBe(5);
    }
    for (let i = 1; i < played.length; i++) expect(played[i]).not.toBe(played[i - 1]);
  });

  it('turning shuffle on reshuffles only what is left; turning it off resumes album order', () => {
    let q = playContext(emptyQueue(), album, T, 1);
    q = setShuffle(q, true, rng(5));
    expect(q.current!.trackId).toBe(T[1]);
    expect(tids(q.later).sort()).toEqual([T[2], T[3], T[4]].sort());
    q = setShuffle(q, false);
    expect(tids(q.later)).toEqual([T[2], T[3], T[4]]);
  });
});

describe('advance / back / repeat', () => {
  it('signals the end of the queue without changing it', () => {
    const q = playContext(emptyQueue(), album, T, 4);
    const r = advance(q);
    expect(r.ended).toBe(true);
    expect(r.queue).toBe(q);
  });

  it('repeat-one replays on natural end but a manual next still moves on', () => {
    const q = setRepeat(playContext(emptyQueue(), album, T, 0), 'one');
    expect(advance(q, { auto: true })).toMatchObject({ repeatedCurrent: true, queue: q });
    expect(advance(q, { auto: false }).queue.current!.trackId).toBe(T[1]);
  });

  it('repeat-all wraps to the start in album order', () => {
    const q = setRepeat(playContext(emptyQueue(), album, T, 4), 'all');
    expect(peekNext(q)!.trackId).toBe(T[0]);
    expect(advance(q).queue.current!.trackId).toBe(T[0]);
  });

  it('cycles repeat off → all → one → off', () => {
    let q = emptyQueue();
    const seen = [q.repeat];
    for (let i = 0; i < 3; i++) seen.push((q = cycleRepeat(q)).repeat);
    expect(seen).toEqual(['off', 'all', 'one', 'off']);
  });

  it('back returns to the previous track and puts the current one back in its list', () => {
    let q = playContext(emptyQueue(), album, T, 0);
    q = advance(q).queue;
    q = addToQueue(q, ['qa'.padEnd(20, 'x')]);
    q = advance(q).queue; // plays queued track
    expect(q.current!.origin).toBe('queue');
    const b = back(q)!;
    expect(b.current!.trackId).toBe(T[1]);
    expect(tids(b.upNext)).toEqual(['qa'.padEnd(20, 'x')]);
    const bb = back(b)!;
    expect(bb.current!.trackId).toBe(T[0]);
    expect(tids(bb.later)).toEqual([T[1], T[2], T[3], T[4]]);
    expect(back(bb)).toBeNull();
  });

  it('caps history', () => {
    let q = setRepeat(playContext(emptyQueue(), album, T, 0), 'all');
    for (let i = 0; i < 250; i++) q = advance(q).queue;
    expect(q.history.length).toBe(100);
  });
});

describe('user queue', () => {
  const Q = ['qa', 'qb', 'qc'].map((s) => s.padEnd(20, 'x'));

  it('play next goes to the front, add to queue to the back, both before the album', () => {
    let q = playContext(emptyQueue(), album, T, 0);
    q = addToQueue(q, [Q[0]!]);
    q = playNext(q, [Q[1]!, Q[2]!]);
    expect(tids(upcoming(q))).toEqual([Q[1], Q[2], Q[0], T[1], T[2], T[3], T[4]]);
    expect(peekNext(q)!.trackId).toBe(Q[1]);
  });

  it('allows the same track twice with distinct uids', () => {
    const q = addToQueue(addToQueue(emptyQueue(), [Q[0]!]), [Q[0]!]);
    expect(q.upNext[0]!.uid).not.toBe(q.upNext[1]!.uid);
  });

  it('removes and clears', () => {
    let q = addToQueue(playContext(emptyQueue(), album, T, 0), Q);
    q = removeUpcoming(q, q.upNext[1]!.uid);
    q = removeUpcoming(q, q.later[0]!.uid);
    expect(tids(q.upNext)).toEqual([Q[0], Q[2]]);
    expect(tids(q.later)).toEqual([T[2], T[3], T[4]]);
    expect(clearUpNext(q).upNext).toEqual([]);
  });

  it('drag-and-drop reorders and moves entries between sections', () => {
    let q = addToQueue(playContext(emptyQueue(), album, T, 0), [Q[0]!, Q[1]!]);
    // Reorder inside the queue
    q = moveUpcoming(q, q.upNext[1]!.uid, q.upNext[0]!.uid);
    expect(tids(q.upNext)).toEqual([Q[1], Q[0]]);
    // Drag an album track into the queue section
    q = moveUpcoming(q, q.later[2]!.uid, q.upNext[0]!.uid);
    expect(tids(q.upNext)).toEqual([T[3], Q[1], Q[0]]);
    expect(q.upNext[0]!.origin).toBe('queue');
    expect(tids(q.later)).toEqual([T[1], T[2], T[4]]);
    // Drag a queued track down into the album section (dragging down lands after the target,
    // like dnd-kit's arrayMove)
    q = moveUpcoming(q, q.upNext[0]!.uid, q.later[1]!.uid);
    expect(tids(q.later)).toEqual([T[1], T[2], T[3], T[4]]);
    expect(q.later[2]!.origin).toBe('context');
  });

  it('jumping drops skipped queued entries but keeps the queue when jumping into the album', () => {
    let q = addToQueue(playContext(emptyQueue(), album, T, 0), Q);
    const j1 = jumpTo(q, q.upNext[1]!.uid);
    expect(j1.current!.trackId).toBe(Q[1]);
    expect(tids(j1.upNext)).toEqual([Q[2]]);
    q = jumpTo(q, q.later[2]!.uid);
    expect(q.current!.trackId).toBe(T[3]);
    expect(tids(q.upNext)).toEqual(Q);
    expect(tids(q.later)).toEqual([T[4]]);
    expect(tids(q.history)).toEqual([T[0]]);
  });
});

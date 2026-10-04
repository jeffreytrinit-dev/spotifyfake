import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { QueueEntry } from '@tidepool/shared';
import { GripVertical, X } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Artwork } from '../components/Artwork.js';
import { IconButton } from '../components/IconButton.js';
import { formatTime } from '../lib/format.js';
import { usePlayer } from '../player/store.js';
import { useTrackCache } from '../player/track-cache.js';

const SHOW_LATER = 100;

function TrackLine({ entry, dim = false }: { entry: QueueEntry; dim?: boolean }) {
  const t = useTrackCache((s) => s.byId[entry.trackId]);
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-3 ${dim ? 'opacity-60' : ''}`}>
      <Artwork artworkId={t?.artworkId} size={64} alt="" className="h-10 w-10" rounded="rounded" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{t?.title ?? '…'}</p>
        <p className="truncate text-xs text-muted">{t?.artistDisplay ?? ''}</p>
      </div>
      <span className="hidden text-xs tabular-nums text-muted sm:inline">
        {t ? formatTime(t.durationMs) : ''}
      </span>
    </div>
  );
}

function SortableRow({ entry }: { entry: QueueEntry }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.uid });
  const { jumpTo, removeFromQueue } = usePlayer.getState();
  const title = useTrackCache((s) => s.byId[entry.trackId]?.title ?? 'track');
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-1 rounded-lg px-1 py-1 ${isDragging ? 'z-10 bg-raised shadow-lg' : 'hover:bg-surface-2'}`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`Reorder ${title}`}
        className="flex h-10 w-8 shrink-0 cursor-grab touch-none items-center justify-center text-muted active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={18} />
      </button>
      <button
        type="button"
        className="flex min-w-0 flex-1 text-left"
        onClick={() => jumpTo(entry.uid)}
        aria-label={`Play ${title} now`}
      >
        <TrackLine entry={entry} />
      </button>
      <IconButton
        label={`Remove ${title} from queue`}
        size="sm"
        onClick={() => removeFromQueue(entry.uid)}
      >
        <X size={16} />
      </IconButton>
    </li>
  );
}

export function QueuePage() {
  const queue = usePlayer((s) => s.queue);
  const { moveInQueue, clearQueue } = usePlayer.getState();
  const later = useMemo(() => queue.later.slice(0, SHOW_LATER), [queue.later]);
  const history = useMemo(() => [...queue.history].reverse().slice(0, 30), [queue.history]);
  const ids = useMemo(() => [...queue.upNext, ...later].map((e) => e.uid), [queue.upNext, later]);

  useEffect(() => {
    void useTrackCache
      .getState()
      .ensure([...queue.upNext, ...later, ...history].map((e) => e.trackId));
  }, [queue.upNext, later, history]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) moveInQueue(String(e.active.id), String(e.over.id));
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="mb-6 text-2xl font-bold">Queue</h1>

      {queue.current ? (
        <section aria-labelledby="q-now" className="mb-8">
          <h2 id="q-now" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
            Now playing
          </h2>
          <div className="px-2">
            <TrackLine entry={queue.current} />
          </div>
        </section>
      ) : (
        <p className="text-muted">Nothing is playing. Pick an album to get started.</p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {queue.upNext.length > 0 && (
            <section aria-labelledby="q-next" className="mb-8">
              <div className="mb-2 flex items-center justify-between">
                <h2
                  id="q-next"
                  className="text-sm font-semibold uppercase tracking-wide text-muted"
                >
                  Next in queue
                </h2>
                <button
                  type="button"
                  onClick={clearQueue}
                  className="rounded-full px-3 py-1 text-sm text-muted hover:bg-surface-2 hover:text-fg"
                >
                  Clear queue
                </button>
              </div>
              <ul>
                {queue.upNext.map((e) => (
                  <SortableRow key={e.uid} entry={e} />
                ))}
              </ul>
            </section>
          )}
          {later.length > 0 && (
            <section aria-labelledby="q-later" className="mb-8">
              <h2
                id="q-later"
                className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted"
              >
                Next from: {queue.context?.name ?? 'your selection'}
              </h2>
              <ul>
                {later.map((e) => (
                  <SortableRow key={e.uid} entry={e} />
                ))}
              </ul>
              {queue.later.length > SHOW_LATER && (
                <p className="mt-2 px-2 text-sm text-muted">
                  …and {queue.later.length - SHOW_LATER} more
                </p>
              )}
            </section>
          )}
        </SortableContext>
      </DndContext>

      {history.length > 0 && (
        <section aria-labelledby="q-history">
          <h2
            id="q-history"
            className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted"
          >
            Recently played
          </h2>
          <ul className="space-y-1 px-2">
            {history.map((e) => (
              <li key={e.uid}>
                <TrackLine entry={e} dim />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

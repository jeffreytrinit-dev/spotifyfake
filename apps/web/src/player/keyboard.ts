export type ShortcutAction =
  | 'togglePlay'
  | 'seekBack'
  | 'seekForward'
  | 'previous'
  | 'next'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute'
  | 'shuffle'
  | 'repeat'
  | 'queue'
  | 'nowPlaying'
  | 'help';

export const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'Space / K', label: 'Play / pause' },
  { keys: '← / →', label: 'Back / forward 10 seconds' },
  { keys: 'Shift + ← / →', label: 'Previous / next track' },
  { keys: '↑ / ↓', label: 'Volume up / down' },
  { keys: 'M', label: 'Mute' },
  { keys: 'S', label: 'Shuffle' },
  { keys: 'R', label: 'Repeat (off → all → one)' },
  { keys: 'Q', label: 'Show the queue' },
  { keys: 'F', label: 'Full-screen player' },
  { keys: '?', label: 'This list' },
];

type KeyInfo = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>;

/** Map a key press to a player action. Pure, so it's easy to test. */
export function shortcutFor(e: KeyInfo): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null; // leave browser/OS shortcuts alone
  switch (e.key) {
    case ' ':
    case 'k':
    case 'K':
      return 'togglePlay';
    case 'ArrowLeft':
      return e.shiftKey ? 'previous' : 'seekBack';
    case 'ArrowRight':
      return e.shiftKey ? 'next' : 'seekForward';
    case 'ArrowUp':
      return 'volumeUp';
    case 'ArrowDown':
      return 'volumeDown';
    case 'm':
    case 'M':
      return 'mute';
    case 's':
    case 'S':
      return 'shuffle';
    case 'r':
    case 'R':
      return 'repeat';
    case 'q':
    case 'Q':
      return 'queue';
    case 'f':
    case 'F':
      return 'nowPlaying';
    case '?':
      return 'help';
    default:
      return null;
  }
}

/** Typing in a field, or a focused control that already handles these keys, wins. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // Drag handles (keyboard reordering) and open menus use the arrow keys themselves.
  if (target.closest('[aria-roledescription="sortable"], [role="menu"]')) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'button';
  }
  return false;
}

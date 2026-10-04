import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { isTypingTarget, shortcutFor } from '../player/keyboard.js';
import { usePlayer } from '../player/store.js';
import { useUi } from './ui-store.js';

export function useKeyboardShortcuts(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      // Space on a focused button should press that button, not toggle playback.
      if (e.key === ' ' && e.target instanceof HTMLButtonElement) return;
      const action = shortcutFor(e);
      if (!action) return;
      const p = usePlayer.getState();
      const ui = useUi.getState();
      e.preventDefault();
      switch (action) {
        case 'togglePlay':
          return p.togglePlay();
        case 'seekBack':
          return p.seekBy(-10_000);
        case 'seekForward':
          return p.seekBy(10_000);
        case 'previous':
          return p.previous();
        case 'next':
          return p.next();
        case 'volumeUp':
          return p.setVolume(p.volume + 0.05);
        case 'volumeDown':
          return p.setVolume(p.volume - 0.05);
        case 'mute':
          return p.toggleMute();
        case 'shuffle':
          return p.toggleShuffle();
        case 'repeat':
          return p.cycleRepeat();
        case 'queue':
          ui.setNowPlaying(false);
          return void navigate('/queue');
        case 'nowPlaying':
          return ui.setNowPlaying(!ui.nowPlayingOpen);
        case 'help':
          return ui.setShortcuts(!ui.shortcutsOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}

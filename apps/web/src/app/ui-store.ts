import { create } from 'zustand';

interface UiState {
  nowPlayingOpen: boolean;
  shortcutsOpen: boolean;
  toast: { id: number; message: string; tone: 'info' | 'error' } | null;
  setNowPlaying(open: boolean): void;
  setShortcuts(open: boolean): void;
  showToast(message: string, tone?: 'info' | 'error'): void;
  clearToast(): void;
}

export const useUi = create<UiState>((set) => ({
  nowPlayingOpen: false,
  shortcutsOpen: false,
  toast: null,
  setNowPlaying: (nowPlayingOpen) => set({ nowPlayingOpen }),
  setShortcuts: (shortcutsOpen) => set({ shortcutsOpen }),
  showToast: (message, tone = 'info') => set({ toast: { id: Date.now(), message, tone } }),
  clearToast: () => set({ toast: null }),
}));

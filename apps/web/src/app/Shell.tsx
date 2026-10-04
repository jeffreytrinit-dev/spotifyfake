import { Home, ListMusic, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { Toasts } from '../components/Toast.js';
import { SHORTCUTS } from '../player/keyboard.js';
import { NowPlaying } from '../player-ui/NowPlaying.js';
import { PlayerBar } from '../player-ui/PlayerBar.js';
import { useUi } from './ui-store.js';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/queue', label: 'Queue', icon: ListMusic, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
];

function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcuts);
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-raised p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">Keyboard shortcuts</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {SHORTCUTS.map((k) => (
            <div key={k.keys} className="contents">
              <dt className="font-mono text-xs text-muted">{k.keys}</dt>
              <dd>{k.label}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          autoFocus
          onClick={() => setOpen(false)}
          className="mt-6 w-full rounded-full border border-line py-2 text-sm hover:bg-surface-2"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/** Phone: content, then mini player + tab bar pinned to the bottom. Desktop: sidebar + full player bar. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-raised focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Main"
          className="hidden w-56 shrink-0 flex-col gap-1 border-r border-line bg-surface p-3 md:flex"
        >
          <div className="mb-4 flex items-center gap-2 px-3 py-2">
            <img src="/icons/favicon.svg" alt="" className="h-8 w-8" />
            <span className="text-lg font-bold tracking-tight">Tidepool</span>
          </div>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'}`
              }
            >
              <Icon size={20} aria-hidden /> {label}
            </NavLink>
          ))}
        </nav>
        <main id="main" className="min-w-0 flex-1 overflow-y-auto pt-safe">
          {children}
        </main>
      </div>
      <PlayerBar />
      <nav aria-label="Main" className="flex border-t border-line bg-surface pb-safe md:hidden">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-fg' : 'text-muted'}`
            }
          >
            <Icon size={22} aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
      <NowPlaying />
      <ShortcutsDialog />
      <Toasts />
    </div>
  );
}

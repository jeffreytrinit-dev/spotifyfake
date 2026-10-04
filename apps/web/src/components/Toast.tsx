import { useEffect } from 'react';
import { useUi } from '../app/ui-store.js';
import { usePlayer } from '../player/store.js';

/** One toast at a time, announced politely to screen readers. Player errors show here too. */
export function Toasts() {
  const toast = useUi((s) => s.toast);
  const clear = useUi((s) => s.clearToast);
  const playerError = usePlayer((s) => s.error);
  const dismissPlayerError = usePlayer((s) => s.dismissError);
  const show = useUi((s) => s.showToast);

  useEffect(() => {
    if (playerError) {
      show(playerError, 'error');
      dismissPlayerError();
    }
  }, [playerError, show, dismissPlayerError]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clear, 4000);
    return () => clearTimeout(t);
  }, [toast, clear]);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center pt-safe"
    >
      {toast && (
        <div
          key={toast.id}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto mt-3 max-w-[90vw] rounded-xl px-4 py-3 text-sm shadow-xl ${
            toast.tone === 'error' ? 'bg-danger text-white' : 'bg-raised text-fg'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

import { useEffect } from 'react';
import type { UserSettingsDto } from '@tidepool/shared';

export function useTheme(theme: UserSettingsDto['theme'] | undefined): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolved = theme === 'LIGHT' || (theme === 'SYSTEM' && mq.matches) ? 'light' : 'dark';
      document.documentElement.dataset.theme = resolved;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', resolved === 'light' ? '#f5f7fb' : '#0b1220');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

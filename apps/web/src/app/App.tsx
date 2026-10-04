import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@tidepool/shared';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { onUnauthorized } from '../api/client.js';
import { keys, useMe, useSettings, useSetupStatus } from '../api/queries.js';
import { AlbumPage } from '../pages/AlbumPage.js';
import { LoginPage, SetupPage } from '../pages/AuthPages.js';
import { HomePage } from '../pages/HomePage.js';
import { QueuePage } from '../pages/QueuePage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { configurePlayer, resetPlayer, restorePlayer } from '../player/store.js';
import { Shell } from './Shell.js';
import { useKeyboardShortcuts } from './useShortcuts.js';
import { useTheme } from './useTheme.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
});

function Splash({ message }: { message?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-muted">
      <img src="/icons/favicon.svg" alt="" className="h-14 w-14 animate-pulse" />
      {message && <p className="max-w-xs text-center text-sm">{message}</p>}
    </div>
  );
}

function SignedIn({ me }: { me: MeResponse }) {
  const settings = useSettings();
  useTheme(settings.data?.theme);
  useKeyboardShortcuts();
  useEffect(() => void restorePlayer(me.id), [me.id]);
  useEffect(() => {
    if (settings.data) configurePlayer(settings.data);
  }, [settings.data]);

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/album/:id" element={<AlbumPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function AuthGate() {
  const me = useMe();
  const setup = useSetupStatus(me.data === null);

  useEffect(
    () =>
      onUnauthorized(() => {
        resetPlayer();
        queryClient.setQueryData(keys.me, null);
      }),
    [],
  );

  if (me.isLoading) return <Splash />;
  if (me.isError)
    return (
      <Splash message="Can't reach your Tidepool server. Check that it's running and that you're on the same network." />
    );
  if (!me.data) {
    if (setup.isLoading) return <Splash />;
    return setup.data?.needsSetup ? <SetupPage /> : <LoginPage />;
  }
  return <SignedIn me={me.data} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

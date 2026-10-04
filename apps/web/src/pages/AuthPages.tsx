import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@tidepool/shared';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api/client.js';
import { keys } from '../api/queries.js';

function Field(props: {
  label: string;
  type: string;
  name: string;
  autoComplete: string;
  minLength?: number;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted">{props.label}</span>
      <input
        required
        type={props.type}
        name={props.name}
        autoComplete={props.autoComplete}
        {...(props.minLength ? { minLength: props.minLength } : {})}
        autoFocus={props.autoFocus}
        className="w-full rounded-xl border border-line bg-surface-2 px-4 py-3 text-base outline-none focus:border-sea"
      />
    </label>
  );
}

function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-full items-center justify-center px-6 pt-safe pb-safe">
      <div className="w-full max-w-sm">
        <img src="/icons/favicon.svg" alt="" className="mx-auto mb-6 h-16 w-16" />
        <h1 className="text-center text-2xl font-bold">{title}</h1>
        <p className="mb-8 mt-1 text-center text-sm text-muted">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}

function useAuthSubmit(path: '/auth/login' | '/auth/setup') {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(null);
    try {
      const me = await api<MeResponse>(path, { method: 'POST', body: data });
      qc.setQueryData(keys.me, me);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : err.code === 'BAD_REQUEST' && Array.isArray(err.details)
              ? (err.details as { message: string }[]).map((d) => d.message).join('. ')
              : err.message
          : 'Could not reach the server.',
      );
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

export function LoginPage() {
  const { submit, error, busy } = useAuthSubmit('/auth/login');
  return (
    <AuthCard title="Welcome back" subtitle="Sign in to your Tidepool">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" type="email" name="email" autoComplete="username" autoFocus />
        <Field label="Password" type="password" name="password" autoComplete="current-password" />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button
          disabled={busy}
          className="w-full rounded-full bg-accent py-3 font-semibold text-on-accent hover:bg-accent-strong disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  );
}

export function SetupPage() {
  const { submit, error, busy } = useAuthSubmit('/auth/setup');
  return (
    <AuthCard
      title="Set up Tidepool"
      subtitle="Create the admin account for this server. You only do this once."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name" type="text" name="displayName" autoComplete="name" autoFocus />
        <Field label="Email" type="email" name="email" autoComplete="username" />
        <Field
          label="Password (at least 10 characters)"
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={10}
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button
          disabled={busy}
          className="w-full rounded-full bg-accent py-3 font-semibold text-on-accent hover:bg-accent-strong disabled:opacity-60"
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </AuthCard>
  );
}

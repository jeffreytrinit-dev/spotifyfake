import { useQueryClient } from '@tanstack/react-query';
import { QUALITY_TIERS, type QualityTier, type UserSettingsDto } from '@tidepool/shared';
import type { ReactNode } from 'react';
import { api } from '../api/client.js';
import {
  keys,
  useLibraryStats,
  useMe,
  useMissingTracks,
  usePurgeMissing,
  useRescan,
  useSettings,
  useUpdateSettings,
} from '../api/queries.js';
import { useUi } from '../app/ui-store.js';
import { Range } from '../components/Range.js';
import { formatDurationLong, TIER_LABEL } from '../lib/format.js';
import { useDeviceSettings } from '../player/device.js';
import { SHORTCUTS } from '../player/keyboard.js';
import { isAppleMobile } from '../player/platform.js';
import { EQ_FREQUENCIES, EQ_PRESETS } from '../player/sound.js';
import { resetPlayer } from '../player/store.js';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 rounded-2xl bg-surface p-5">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 rounded-full transition-colors ${checked ? 'bg-sea' : 'bg-raised'}`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-[left] ${checked ? 'left-6' : 'left-1'}`}
      />
    </button>
  );
}

function TierSelect({
  value,
  onChange,
  label,
}: {
  value: QualityTier;
  onChange(v: QualityTier): void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as QualityTier)}
      className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
    >
      {QUALITY_TIERS.map((t) => (
        <option key={t} value={t}>
          {TIER_LABEL[t]}
          {t === 'LOW'
            ? ' (96 kbps)'
            : t === 'NORMAL'
              ? ' (160 kbps)'
              : t === 'HIGH'
                ? ' (320 kbps)'
                : ' (original)'}
        </option>
      ))}
    </select>
  );
}

export function SettingsPage() {
  const { data: s } = useSettings();
  const update = useUpdateSettings();
  const me = useMe().data;
  const device = useDeviceSettings();
  const apple = isAppleMobile();
  const qc = useQueryClient();
  const set = (patch: Partial<UserSettingsDto>) => update.mutate(patch);

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    resetPlayer();
    qc.setQueryData(keys.me, null);
  };

  if (!s) return <p className="p-6 text-muted">Loading settings…</p>;
  const eqPreset =
    Object.entries(EQ_PRESETS).find(([, b]) => b.every((v, i) => v === s.eqBands[i]))?.[0] ??
    'Custom';

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>

      <Section title="Streaming quality">
        <Row
          label="On Wi-Fi"
          hint={
            apple
              ? 'Your iPhone always uses this one: Safari can’t tell Wi-Fi from mobile data.'
              : undefined
          }
        >
          <TierSelect
            label="Quality on Wi-Fi"
            value={s.streamQualityWifi}
            onChange={(v) => set({ streamQualityWifi: v })}
          />
        </Row>
        <Row label="On mobile data">
          <TierSelect
            label="Quality on mobile data"
            value={s.streamQualityCell}
            onChange={(v) => set({ streamQualityCell: v })}
          />
        </Row>
        <Row
          label="Adjust to connection"
          hint="Lower the quality automatically when the connection is slow."
        >
          <Toggle
            label="Adjust quality to connection"
            checked={s.autoAdjustQuality}
            onChange={(v) => set({ autoAdjustQuality: v })}
          />
        </Row>
      </Section>

      <Section title="Sound">
        {apple && (
          <Row
            label="Sound processing on this iPhone"
            hint="Needed for volume levelling and the equaliser. iOS may pause it when the screen locks; if music stops when locked, turn this off. Takes effect after reopening the app."
          >
            <Toggle
              label="Sound processing on this device"
              checked={device.iosAudioProcessing}
              onChange={(v) => device.update({ iosAudioProcessing: v })}
            />
          </Row>
        )}
        <Row label="Volume levelling" hint="Plays every track at a similar loudness (ReplayGain).">
          <Toggle
            label="Volume levelling"
            checked={s.normalization}
            onChange={(v) => set({ normalization: v })}
          />
        </Row>
        {s.normalization && (
          <Row
            label="Level by"
            hint="Album keeps the loud and quiet songs of an album as the artist intended."
          >
            <select
              aria-label="Level by"
              value={s.normalizationMode}
              onChange={(e) => set({ normalizationMode: e.target.value as 'track' | 'album' })}
              className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
            >
              <option value="track">Track</option>
              <option value="album">Album</option>
            </select>
          </Row>
        )}
        <Row
          label="Crossfade"
          hint={
            apple
              ? 'Not available on iPhone.'
              : 'Blend the end of one song into the next. Never between tracks of the same album.'
          }
        >
          <span className="text-sm tabular-nums text-muted">{s.crossfadeSeconds} s</span>
        </Row>
        {!apple && (
          <Range
            label="Crossfade seconds"
            min={0}
            max={12}
            value={s.crossfadeSeconds}
            valueText={`${s.crossfadeSeconds} seconds`}
            onChange={(v) => set({ crossfadeSeconds: v })}
          />
        )}
        <Row label="Equaliser">
          <Toggle label="Equaliser" checked={s.eqEnabled} onChange={(v) => set({ eqEnabled: v })} />
        </Row>
        {s.eqEnabled && (
          <>
            <div className="flex flex-wrap gap-2">
              {Object.entries(EQ_PRESETS).map(([name, bands]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => set({ eqBands: [...bands], eqPreset: name })}
                  aria-pressed={eqPreset === name}
                  className={`rounded-full border px-3 py-1.5 text-sm ${eqPreset === name ? 'border-sea bg-sea/15 text-sea' : 'border-line hover:bg-surface-2'}`}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-10 gap-1" role="group" aria-label="Equaliser bands">
              {EQ_FREQUENCIES.map((f, i) => (
                <label key={f} className="flex flex-col items-center gap-2 text-[10px] text-muted">
                  <span className="tabular-nums text-fg">
                    {s.eqBands[i]! > 0 ? '+' : ''}
                    {s.eqBands[i]}
                  </span>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={1}
                    value={s.eqBands[i]}
                    aria-label={`${f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`} band, decibels`}
                    onChange={(e) => {
                      const bands = [...s.eqBands];
                      bands[i] = Number(e.target.value);
                      set({ eqBands: bands, eqPreset: null });
                    }}
                    className="h-28 w-6 cursor-pointer accent-[var(--tp-sea)] [writing-mode:vertical-lr] [direction:rtl]"
                  />
                  <span>{f >= 1000 ? `${f / 1000}k` : f}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </Section>

      <Section title="Appearance">
        <Row label="Theme">
          <select
            aria-label="Theme"
            value={s.theme}
            onChange={(e) => set({ theme: e.target.value as UserSettingsDto['theme'] })}
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm"
          >
            <option value="DARK">Dark</option>
            <option value="LIGHT">Light</option>
            <option value="SYSTEM">Match device</option>
          </select>
        </Row>
      </Section>

      {!apple && (
        <Section title="Keyboard shortcuts">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            {SHORTCUTS.map((k) => (
              <div key={k.keys} className="contents">
                <dt className="font-mono text-xs text-muted">{k.keys}</dt>
                <dd>{k.label}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      <LibrarySection isAdmin={me?.role === 'ADMIN'} />

      <Section title="Account">
        <Row label={me?.displayName ?? ''} hint={me?.email}>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-full border border-line px-4 py-2 text-sm hover:bg-surface-2"
          >
            Sign out
          </button>
        </Row>
      </Section>
    </div>
  );
}

function LibrarySection({ isAdmin }: { isAdmin: boolean }) {
  const stats = useLibraryStats().data;
  const missing = useMissingTracks();
  const purge = usePurgeMissing();
  const rescan = useRescan();
  const toast = useUi((s) => s.showToast);
  const items = missing.data?.items ?? [];

  return (
    <Section title="Library">
      {stats && (
        <p className="text-sm text-muted">
          {stats.tracks} songs · {stats.albums} albums · {stats.artists} artists ·{' '}
          {formatDurationLong(stats.totalDurationMs)}
        </p>
      )}
      {isAdmin && (
        <Row
          label="Rescan music folder"
          hint="New and changed files are picked up automatically; use this if something was missed."
        >
          <button
            type="button"
            disabled={rescan.isPending}
            onClick={() =>
              rescan.mutate(undefined, {
                onSuccess: () => toast('Rescan started'),
                onError: (e) => toast(e.message, 'error'),
              })
            }
            className="rounded-full border border-line px-4 py-2 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            Rescan
          </button>
        </Row>
      )}
      <div>
        <p className="text-sm font-medium">Missing files</p>
        <p className="mt-0.5 text-xs text-muted">
          Songs whose files disappeared from the music folder. They keep their place in playlists,
          likes and history until you remove them. If a drive is just unplugged, plug it back in
          instead.
        </p>
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-muted">None. Everything is where it should be.</p>
        ) : (
          <>
            <ul className="mt-3 max-h-64 divide-y divide-line overflow-auto rounded-xl border border-line">
              {items.map((m) => (
                <li key={m.id} className="px-3 py-2 text-sm">
                  <p className="truncate font-medium">
                    {m.title} <span className="font-normal text-muted">· {m.artistDisplay}</span>
                  </p>
                  <p className="truncate font-mono text-xs text-muted">{m.path}</p>
                </li>
              ))}
            </ul>
            {isAdmin && (
              <button
                type="button"
                disabled={purge.isPending}
                onClick={() => {
                  if (
                    !confirm(
                      `Remove ${items.length} missing song(s) for good? This also removes them from playlists and history.`,
                    )
                  )
                    return;
                  purge.mutate(undefined, {
                    onSuccess: (r) => toast(`Removed ${r.removed} missing song(s)`),
                    onError: (e) => toast(e.message, 'error'),
                  });
                }}
                className="mt-3 rounded-full bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Remove {items.length} missing song{items.length === 1 ? '' : 's'}
              </button>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

import { adaptTier, ThroughputEstimator, type QualityTier } from '@tidepool/shared';

const PROBE_BYTES = 256 * 1024;
const MIN_PROBE_INTERVAL_MS = 2 * 60_000;

/**
 * Adaptive quality: every couple of minutes (at most), time a 256 KiB ranged download of the
 * track that's starting and feed it to the estimator. The tier used for the *next* loads is
 * `adaptTier(preferred, current, estimate)`: it drops at once on a slow link and climbs back
 * one step at a time.
 */
export class AdaptiveQuality {
  private readonly estimator = new ThroughputEstimator();
  private lastProbe = 0;
  private tier: QualityTier | null = null;

  /** Tier to request now, given the user's preferred tier. */
  current(preferred: QualityTier, enabled: boolean): QualityTier {
    if (!enabled) return (this.tier = preferred);
    this.tier = adaptTier(preferred, this.tier ?? preferred, this.estimator.estimateKbps());
    return this.tier;
  }

  estimateKbps(): number | null {
    return this.estimator.estimateKbps();
  }

  /** Measure throughput against a track's original file. Never throws. */
  async probe(trackId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
    const now = Date.now();
    if (now - this.lastProbe < MIN_PROBE_INTERVAL_MS) return;
    this.lastProbe = now;
    try {
      const started = performance.now();
      const res = await fetchImpl(`/api/v1/stream/${encodeURIComponent(trackId)}/original`, {
        headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const bytes = (await res.arrayBuffer()).byteLength;
      this.estimator.addSample(bytes, performance.now() - started);
    } catch {
      // Offline or aborted: no sample.
    }
  }
}

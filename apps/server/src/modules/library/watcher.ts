import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { FastifyBaseLogger } from 'fastify';
import { isAudioFile } from './metadata.js';
import type { LibraryService } from './service.js';

/**
 * Collects filesystem events and hands them to the scanner in debounced batches, so copying
 * an album in produces one incremental scan rather than one per file.
 */
export class LibraryWatcher {
  private watcher: FSWatcher | null = null;
  private changed = new Set<string>();
  private removed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly musicDir: string,
    private readonly library: LibraryService,
    private readonly log: FastifyBaseLogger,
    private readonly opts: { polling: boolean; debounceMs?: number },
  ) {}

  start(): Promise<void> {
    const w = watch(this.musicDir, {
      ignoreInitial: true,
      usePolling: this.opts.polling,
      interval: 5000,
      ignored: (p) => path.basename(p).startsWith('.') && p !== this.musicDir,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 250 },
    });
    this.watcher = w;
    w.on('add', (p) => isAudioFile(p) && this.push('changed', p))
      .on('change', (p) => isAudioFile(p) && this.push('changed', p))
      .on('addDir', (p) => this.push('changed', p))
      .on('unlink', (p) => isAudioFile(p) && this.push('removed', p))
      .on('unlinkDir', (p) => this.push('removed', p))
      .on('error', (err) => this.log.error({ err }, 'watcher: error'));
    return new Promise((resolve) => w.once('ready', () => resolve()));
  }

  private push(kind: 'changed' | 'removed', p: string): void {
    (kind === 'changed' ? this.changed : this.removed).add(p);
    if (kind === 'changed') this.removed.delete(p);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 1500);
  }

  private flush(): void {
    this.timer = null;
    const changed = [...this.changed];
    const removed = [...this.removed];
    this.changed.clear();
    this.removed.clear();
    if (!changed.length && !removed.length) return;
    this.log.info(
      { changed: changed.length, removed: removed.length },
      'watcher: changes detected',
    );
    this.library
      .scanPaths(changed, removed)
      .catch((err: unknown) => this.log.error({ err }, 'watcher: scan failed'));
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
  }
}

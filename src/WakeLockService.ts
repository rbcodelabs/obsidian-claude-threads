import { spawn, type ChildProcess } from 'child_process';

type SpawnFn = typeof spawn;

export interface WakeLockServiceOptions {
  enabled?: boolean;
  /** Injected spawn function — used in tests to avoid actually running caffeinate. */
  spawnFn?: SpawnFn;
  /** Override platform detection (e.g. in tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Prevents the computer from sleeping while one or more Claude sessions are
 * active.  Tracks a reference count: the lock is acquired when the first
 * session starts and released only when the last one finishes.
 *
 * Strategy (in priority order):
 *  1. macOS — spawns `caffeinate -i` (prevents idle system sleep, no UI needed)
 *  2. All platforms — Web Wake Lock API (`navigator.wakeLock`, screen-only)
 *  3. No-op if neither is available
 */
export class WakeLockService {
  private activeCount = 0;
  private caffeinate: ChildProcess | null = null;
  private webLock: WakeLockSentinel | null = null;
  private enabled: boolean;
  private readonly spawnFn: SpawnFn;
  private readonly platform: NodeJS.Platform;
  private onChangeCallback: ((isActive: boolean) => void) | null = null;

  constructor(options: WakeLockServiceOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.spawnFn = options.spawnFn ?? spawn;
    this.platform = options.platform ?? process.platform;
  }

  /** Called whenever the lock is acquired or released. */
  onChange(cb: (isActive: boolean) => void): void {
    this.onChangeCallback = cb;
  }

  /** Enable or disable the service. Releasing immediately if currently locked. */
  setEnabled(enabled: boolean): void {
    const wasEnabled = this.enabled;
    this.enabled = enabled;
    if (wasEnabled && !enabled && this.activeCount > 0) {
      this.stopLock();
      this.onChangeCallback?.(false);
    } else if (!wasEnabled && enabled && this.activeCount > 0) {
      this.startLock();
      this.onChangeCallback?.(true);
    }
  }

  /** Call once when a session becomes active. */
  acquire(): void {
    this.activeCount++;
    if (this.activeCount === 1 && this.enabled) {
      this.startLock();
      this.onChangeCallback?.(true);
    }
  }

  /** Call once when a session finishes (done, error, or interrupted). */
  release(): void {
    if (this.activeCount <= 0) return;
    this.activeCount--;
    if (this.activeCount === 0) {
      this.stopLock();
      this.onChangeCallback?.(false);
    }
  }

  /** Whether the lock is currently held (i.e. at least one session is active). */
  isActive(): boolean {
    return this.activeCount > 0 && this.enabled;
  }

  /** Current active session count (for status display). */
  get sessionCount(): number {
    return this.activeCount;
  }

  /** Release all locks and reset state. Call on plugin unload. */
  destroy(): void {
    this.activeCount = 0;
    this.stopLock();
    this.onChangeCallback = null;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private startLock(): void {
    if (this.platform === 'darwin') {
      this.startCaffeinate();
    } else {
      this.startWebLock();
    }
  }

  private stopLock(): void {
    this.stopCaffeinate();
    this.releaseWebLock();
  }

  private startCaffeinate(): void {
    if (this.caffeinate) return; // already running
    try {
      this.caffeinate = this.spawnFn('caffeinate', ['-i'], {
        detached: false,
        stdio: 'ignore',
      });
      this.caffeinate.on('exit', () => {
        this.caffeinate = null;
        // If we still have active sessions and the process died unexpectedly,
        // restart it.
        if (this.activeCount > 0 && this.enabled) {
          this.startCaffeinate();
        }
      });
    } catch (err) {
      console.warn('[WakeLockService] caffeinate failed, falling back to Web Lock API', err);
      this.startWebLock();
    }
  }

  private stopCaffeinate(): void {
    if (this.caffeinate) {
      this.caffeinate.removeAllListeners('exit');
      this.caffeinate.kill();
      this.caffeinate = null;
    }
  }

  private startWebLock(): void {
    // navigator may not be present in non-browser environments (e.g. Node tests)
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    navigator.wakeLock
      .request('screen')
      .then((lock) => {
        this.webLock = lock;
      })
      .catch((err: unknown) => {
        console.warn('[WakeLockService] Web Wake Lock request failed', err);
      });
  }

  private releaseWebLock(): void {
    if (this.webLock) {
      this.webLock.release().catch(() => {
        // Ignore errors on release
      });
      this.webLock = null;
    }
  }
}

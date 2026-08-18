import { spawn, type ChildProcess } from 'child_process';

type SpawnFn = typeof spawn;

export interface NativePowerSaveBlockerBridge {
  acquirePowerSaveBlocker(): Promise<string>;
  releasePowerSaveBlocker(token: string): Promise<boolean>;
}

export interface WakeLockServiceOptions {
  enabled?: boolean;
  /** Injected spawn function — used in tests to avoid actually running caffeinate. */
  spawnFn?: SpawnFn;
  /** Override platform detection (e.g. in tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injected Geode bridge. Defaults to window.geode when its wake-lock methods exist. */
  nativeBridge?: NativePowerSaveBlockerBridge;
}

/**
 * Prevents the computer from sleeping while one or more Claude sessions are
 * active.  Tracks a reference count: the lock is acquired when the first
 * session starts and released only when the last one finishes.
 *
 * Strategy (in priority order):
 *  1. Geode — native Electron powerSaveBlocker through the preload bridge
 *  2. macOS fallback — spawns `caffeinate -i` (for Obsidian)
 *  3. All platforms — Web Wake Lock API (`navigator.wakeLock`, screen-only)
 *  4. No-op if none are available
 */
export class WakeLockService {
  private activeCount = 0;
  private caffeinate: ChildProcess | null = null;
  private webLock: WakeLockSentinel | null = null;
  private enabled: boolean;
  private readonly spawnFn: SpawnFn;
  private readonly platform: NodeJS.Platform;
  private readonly nativeBridge: NativePowerSaveBlockerBridge | null;
  private nativeToken: string | null = null;
  private nativeRequestId = 0;
  private onChangeCallback: ((isActive: boolean) => void) | null = null;

  constructor(options: WakeLockServiceOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.spawnFn = options.spawnFn ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.nativeBridge = options.nativeBridge ?? this.detectNativeBridge();
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
    if (this.nativeBridge) {
      this.startNativeLock();
      return;
    }
    this.startFallbackLock();
  }

  private startFallbackLock(): void {
    if (this.platform === 'darwin') {
      this.startCaffeinate();
    } else {
      this.startWebLock();
    }
  }

  private stopLock(): void {
    this.nativeRequestId++;
    this.releaseNativeLock();
    this.stopCaffeinate();
    this.releaseWebLock();
  }

  private detectNativeBridge(): NativePowerSaveBlockerBridge | null {
    if (typeof window === 'undefined') return null;
    const geode = (window as unknown as { geode?: Partial<NativePowerSaveBlockerBridge> }).geode;
    if (
      typeof geode?.acquirePowerSaveBlocker !== 'function'
      || typeof geode.releasePowerSaveBlocker !== 'function'
    ) {
      return null;
    }
    return geode as NativePowerSaveBlockerBridge;
  }

  private startNativeLock(): void {
    if (!this.nativeBridge || this.nativeToken) return;
    const requestId = ++this.nativeRequestId;
    this.nativeBridge.acquirePowerSaveBlocker()
      .then((token) => {
        if (typeof token !== 'string' || token.length === 0) {
          throw new Error('Native power-save blocker returned an invalid token');
        }
        if (requestId !== this.nativeRequestId || this.activeCount === 0 || !this.enabled) {
          this.releaseNativeToken(token);
          return;
        }
        this.nativeToken = token;
      })
      .catch((err: unknown) => {
        if (requestId !== this.nativeRequestId || this.activeCount === 0 || !this.enabled) return;
        console.warn('[WakeLockService] Native power-save blocker failed, falling back', err);
        this.startFallbackLock();
      });
  }

  private releaseNativeLock(): void {
    if (!this.nativeToken) return;
    const token = this.nativeToken;
    this.nativeToken = null;
    this.releaseNativeToken(token);
  }

  private releaseNativeToken(token: string): void {
    this.nativeBridge?.releasePowerSaveBlocker(token).catch((err: unknown) => {
      console.warn('[WakeLockService] Native power-save blocker release failed', err);
    });
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WakeLockService } from '../../src/WakeLockService';
import type { ChildProcess } from 'child_process';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a fake ChildProcess that records kill() calls and exposes a
 * simulateExit() method for triggering the 'exit' event.
 */
function makeFakeProcess() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return proc;
    },
    removeAllListeners(event?: string) {
      if (event) delete listeners[event];
      else for (const k of Object.keys(listeners)) delete listeners[k];
      return proc;
    },
    kill: vi.fn(),
    simulateExit() {
      for (const cb of listeners['exit'] ?? []) cb(0, null);
    },
    pid: 9999,
  } as unknown as ChildProcess & { simulateExit(): void };
  return proc;
}

function makeSpawnFn(proc: ReturnType<typeof makeFakeProcess>) {
  return vi.fn().mockReturnValue(proc) as unknown as typeof import('child_process').spawn;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WakeLockService — lifecycle (macOS path)', () => {
  let proc: ReturnType<typeof makeFakeProcess>;
  let spawnFn: ReturnType<typeof makeSpawnFn>;
  let svc: WakeLockService;

  beforeEach(() => {
    proc = makeFakeProcess();
    spawnFn = makeSpawnFn(proc);
    svc = new WakeLockService({ platform: 'darwin', spawnFn });
  });

  it('does not spawn caffeinate before any acquire()', () => {
    expect(spawnFn).not.toHaveBeenCalled();
    expect(svc.isActive()).toBe(false);
  });

  it('spawns caffeinate with -i on first acquire()', () => {
    svc.acquire();
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledWith('caffeinate', ['-i'], expect.anything());
    expect(svc.isActive()).toBe(true);
  });

  it('does not spawn a second caffeinate on additional acquire() calls', () => {
    svc.acquire();
    svc.acquire();
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(svc.sessionCount).toBe(2);
  });

  it('does not kill caffeinate until the last release()', () => {
    svc.acquire();
    svc.acquire();
    svc.release();
    expect(proc.kill).not.toHaveBeenCalled();
    expect(svc.isActive()).toBe(true);
    svc.release();
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(svc.isActive()).toBe(false);
  });

  it('kills caffeinate on single acquire + release', () => {
    svc.acquire();
    svc.release();
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(svc.isActive()).toBe(false);
    expect(svc.sessionCount).toBe(0);
  });

  it('spawns a fresh caffeinate when acquire() called again after full release', () => {
    svc.acquire();
    svc.release();
    const proc2 = makeFakeProcess();
    spawnFn.mockReturnValue(proc2);
    svc.acquire();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(svc.isActive()).toBe(true);
  });

  it('guards against extra release() calls below zero', () => {
    svc.acquire();
    svc.release();
    svc.release(); // extra — should not throw or go negative
    expect(svc.sessionCount).toBe(0);
    expect(proc.kill).toHaveBeenCalledOnce(); // still only killed once
  });
});

describe('WakeLockService — onChange callback', () => {
  let proc: ReturnType<typeof makeFakeProcess>;
  let svc: WakeLockService;

  beforeEach(() => {
    proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    svc = new WakeLockService({ platform: 'darwin', spawnFn });
  });

  it('fires onChange(true) when lock is first acquired', () => {
    const cb = vi.fn();
    svc.onChange(cb);
    svc.acquire();
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('does not fire onChange on subsequent acquires', () => {
    const cb = vi.fn();
    svc.onChange(cb);
    svc.acquire();
    svc.acquire();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('fires onChange(false) when last session releases', () => {
    const cb = vi.fn();
    svc.onChange(cb);
    svc.acquire();
    svc.acquire();
    svc.release();
    expect(cb).toHaveBeenCalledTimes(1); // only the acquire so far
    svc.release();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(false);
  });
});

describe('WakeLockService — setEnabled()', () => {
  it('does not spawn caffeinate when disabled at construction', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn, enabled: false });
    svc.acquire();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(svc.isActive()).toBe(false);
  });

  it('releases immediately when setEnabled(false) called with active sessions', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn, enabled: true });
    svc.acquire();
    expect(proc.kill).not.toHaveBeenCalled();
    svc.setEnabled(false);
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(svc.isActive()).toBe(false);
  });

  it('fires onChange(false) when setEnabled(false) releases the lock', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn, enabled: true });
    const cb = vi.fn();
    svc.onChange(cb);
    svc.acquire();
    svc.setEnabled(false);
    expect(cb).toHaveBeenLastCalledWith(false);
  });

  it('re-acquires lock when setEnabled(true) called with active sessions', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn, enabled: false });
    svc.acquire(); // no-op since disabled
    expect(spawnFn).not.toHaveBeenCalled();
    svc.setEnabled(true);
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(svc.isActive()).toBe(true);
  });

  it('is a no-op when there are no active sessions', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn, enabled: true });
    svc.setEnabled(false); // no sessions — nothing to kill
    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe('WakeLockService — destroy()', () => {
  it('kills caffeinate and resets count on destroy()', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn });
    svc.acquire();
    svc.acquire();
    svc.destroy();
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(svc.sessionCount).toBe(0);
    expect(svc.isActive()).toBe(false);
  });

  it('is idempotent — safe to call destroy() twice', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn });
    svc.acquire();
    svc.destroy();
    svc.destroy();
    expect(proc.kill).toHaveBeenCalledOnce();
  });

  it('does not fire onChange after destroy()', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn });
    const cb = vi.fn();
    svc.onChange(cb);
    svc.acquire();
    cb.mockClear();
    svc.destroy();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('WakeLockService — caffeinate auto-restart on unexpected exit', () => {
  it('restarts caffeinate if the process exits while sessions are still active', () => {
    const proc1 = makeFakeProcess();
    const proc2 = makeFakeProcess();
    const spawnFn = vi.fn()
      .mockReturnValueOnce(proc1)
      .mockReturnValueOnce(proc2) as unknown as typeof import('child_process').spawn;
    const svc = new WakeLockService({ platform: 'darwin', spawnFn });
    svc.acquire();
    expect(spawnFn).toHaveBeenCalledOnce();
    // Simulate unexpected caffeinate exit
    proc1.simulateExit();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    svc.destroy();
  });

  it('does not restart caffeinate after intentional kill (no active sessions)', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'darwin', spawnFn });
    svc.acquire();
    svc.release(); // kills caffeinate AND removes the 'exit' listener
    // Now simulate the process emitting 'exit' anyway (race condition)
    proc.simulateExit();
    expect(spawnFn).toHaveBeenCalledOnce(); // should not respawn
    svc.destroy();
  });
});

describe('WakeLockService — non-macOS platform', () => {
  it('does not call spawn on Linux (uses Web Lock API path instead)', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    // navigator.wakeLock is not available in Node test env — the service
    // should silently skip it without throwing
    const svc = new WakeLockService({ platform: 'linux', spawnFn });
    svc.acquire();
    expect(spawnFn).not.toHaveBeenCalled();
    svc.release();
  });

  it('does not call spawn on win32', () => {
    const proc = makeFakeProcess();
    const spawnFn = makeSpawnFn(proc);
    const svc = new WakeLockService({ platform: 'win32', spawnFn });
    svc.acquire();
    expect(spawnFn).not.toHaveBeenCalled();
    svc.release();
  });
});

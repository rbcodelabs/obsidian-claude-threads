import { describe, expect, it, vi } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';
import { scheduleVaultThreadRecovery } from '../../src/vaultThreadRecovery';

function thread(id: string, status: Thread['status'] = 'waiting'): Thread {
  return { id, title: id, cwd: '/cwd', messages: [], createdAt: 1, updatedAt: 1, status };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('background vault thread recovery', () => {
  it('returns before the vault scan settles, then filters, normalizes, notifies once, and saves', async () => {
    const scan = deferred<Thread[]>();
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    const events: Array<{ type: string; threadIds?: string[] }> = [];
    manager.subscribe((_threadId, event) => {
      if (event.type === 'threads_loaded') events.push(event);
    });
    const markIncomplete = vi.fn();
    const saveSettings = vi.fn(async () => {});

    const returned = scheduleVaultThreadRecovery({
      knownIds: new Set(['known']),
      loadAllThreads: () => scan.promise,
      loadRecoveredThreads: (threads) => manager.loadThreads(threads, true),
      markOrphanArchiveScanIncomplete: markIncomplete,
      saveSettings,
    });

    expect(returned).toBeUndefined();
    expect(manager.getThreads()).toHaveLength(0);
    expect(saveSettings).not.toHaveBeenCalled();

    scan.resolve([
      thread('known'),
      thread('archived', 'archived'),
      thread('active', 'active'),
      thread('waiting'),
    ]);

    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce());
    expect(manager.getThreads().map((item) => item.id)).toEqual(['active', 'waiting']);
    expect(manager.getThread('active')?.status).toBe('waiting');
    expect(markIncomplete).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: 'threads_loaded', threadIds: ['active', 'waiting'] }]);
  });

  it('handles a rejected scan without saving or an unhandled rejection', async () => {
    const scan = deferred<Thread[]>();
    const logError = vi.fn();
    const saveSettings = vi.fn(async () => {});

    scheduleVaultThreadRecovery({
      knownIds: new Set(),
      loadAllThreads: () => scan.promise,
      loadRecoveredThreads: vi.fn(),
      markOrphanArchiveScanIncomplete: vi.fn(),
      saveSettings,
      logError,
    });
    const error = new Error('scan failed');
    scan.reject(error);

    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(error));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('handles a durable-save failure after loading recovered threads', async () => {
    const error = new Error('save failed');
    const logError = vi.fn();
    const loadRecoveredThreads = vi.fn();

    scheduleVaultThreadRecovery({
      knownIds: new Set(),
      loadAllThreads: async () => [thread('recovered')],
      loadRecoveredThreads,
      markOrphanArchiveScanIncomplete: vi.fn(),
      saveSettings: async () => { throw error; },
      logError,
    });

    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(error));
    expect(loadRecoveredThreads).toHaveBeenCalledOnce();
  });
});

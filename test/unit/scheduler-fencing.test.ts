import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, computeNextRun, type SchedulerOptions } from '../../src/Scheduler';
import type { ScheduledItem } from '../../src/types';

// Regression coverage for the duplicate-cron-fire bug: two coexisting Scheduler
// instances (e.g. during a plugin reload race where the old instance's timers
// haven't been torn down yet — see src/main.ts onunload()) must never both fire
// the same due cron cycle. This file covers the defense-in-depth `claimFire`
// fencing guard and the in-process reentrancy guard.
//
// Scheduler uses window.setTimeout/clearTimeout; alias window to globalThis so
// the fake timers installed by vitest are what the scheduler arms.
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

function makeOptions(overrides: Partial<SchedulerOptions> = {}): {
  options: SchedulerOptions;
  sendMessage: ReturnType<typeof vi.fn>;
  createThread: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const createThread = vi.fn().mockReturnValue({ id: 'new-thread' });
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread,
    sendMessage,
    getDefaultCwd: () => '/tmp',
    ...overrides,
  };
  return { options, sendMessage, createThread };
}

/**
 * A tiny mutable in-memory "disk" — stands in for data.json shared by two
 * coexisting plugin instances. `read`/`write` return/accept deep-ish copies so
 * callers can't accidentally alias state, mirroring how loadData()/saveData()
 * round-trip through JSON in the real plugin.
 */
function makeSharedDisk(initial: ScheduledItem[] = []) {
  let items = initial.map((i) => ({ ...i }));
  return {
    read: (): ScheduledItem[] => items.map((i) => ({ ...i })),
    write: (next: ScheduledItem[]): void => {
      items = next.map((i) => ({ ...i }));
    },
  };
}

/**
 * Builds a claimFire closure that mirrors main.ts's real implementation:
 * reads fresh state from the shared disk (not any per-instance cache), uses
 * nextRun as a fencing token, and atomically advances lastRun/nextRun on a
 * successful claim.
 */
function makeSharedClaimFire(
  disk: ReturnType<typeof makeSharedDisk>,
): NonNullable<SchedulerOptions['claimFire']> {
  return async (item) => {
    const diskItems = disk.read();
    const idx = diskItems.findIndex((i) => i.id === item.id);
    const diskItem = idx >= 0 ? diskItems[idx] : undefined;

    if (!diskItem || !diskItem.enabled || diskItem.nextRun !== item.nextRun) {
      return { claimed: false, fresh: diskItem };
    }

    const claimed: ScheduledItem = {
      ...diskItem,
      lastRun: Date.now(),
      nextRun: computeNextRun(diskItem, true),
    };
    diskItems[idx] = claimed;
    disk.write(diskItems);

    return { claimed: true, fresh: claimed };
  };
}

describe('Scheduler claimFire fencing guard', () => {
  it('fires exactly once total across two coexisting Scheduler instances racing on the same due item', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const createThread = vi.fn().mockReturnValue({ id: 'new-thread' });

    const item: ScheduledItem = {
      id: 'amazon-export',
      name: 'Amazon Monthly Data Export',
      prompt: 'run the export',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      nextRun: Date.now() + 60_000,
    };

    const disk = makeSharedDisk([item]);
    const claimFire = makeSharedClaimFire(disk);

    const makeInstanceOptions = (): SchedulerOptions => ({
      getItems: () => disk.read(),
      saveItem: async (saved) => {
        const items = disk.read();
        const idx = items.findIndex((i) => i.id === saved.id);
        if (idx >= 0) items[idx] = saved;
        else items.push(saved);
        disk.write(items);
      },
      removeItem: async (id) => {
        disk.write(disk.read().filter((i) => i.id !== id));
      },
      createThread,
      sendMessage,
      getDefaultCwd: () => '/tmp',
      claimFire,
    });

    // Simulates two coexisting plugin instances (e.g. old instance mid-shutdown,
    // new instance just constructed) both holding live timers for the same item.
    const schedulerA = new Scheduler(makeInstanceOptions());
    const schedulerB = new Scheduler(makeInstanceOptions());

    schedulerA.start([item]);
    schedulerB.start([item]);

    // Both are due at the same simulated instant.
    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    schedulerA.destroy();
    schedulerB.destroy();
  });

  it('does not create a thread when claimFire reports the cycle already claimed, and rearms against fresh.nextRun', async () => {
    const claimFire = vi.fn();
    const { options, sendMessage, createThread } = makeOptions({ claimFire });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = scheduler.createItem({
      name: 'Amazon S&S Delivery Monitor',
      prompt: 'check delivery status',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
    });

    const freshNextRun = Date.now() + 5 * 60_000;
    const fresh: ScheduledItem = { ...item, lastRun: Date.now(), nextRun: freshNextRun };
    claimFire.mockResolvedValue({ claimed: false, fresh });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(claimFire).toHaveBeenCalledTimes(1);
    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    // The cycle must not be lost: advancing to just before fresh.nextRun still
    // shouldn't fire...
    const remaining = freshNextRun - Date.now();
    await vi.advanceTimersByTimeAsync(remaining - 1_000);
    expect(createThread).not.toHaveBeenCalled();

    // ...but crossing fresh.nextRun fires the next cycle (this time claimed).
    claimFire.mockResolvedValue({
      claimed: true,
      fresh: { ...fresh, lastRun: Date.now(), nextRun: Date.now() + 60_000 },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });

  it('behaves exactly as before when claimFire is absent (backwards compatibility)', async () => {
    const { options, sendMessage, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    scheduler.createItem({
      name: 'One-off reminder',
      prompt: 'do the thing',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });
});

describe('Scheduler in-process reentrancy guard', () => {
  it('only creates one thread when fire() is invoked twice concurrently for the same item id', async () => {
    const { options, sendMessage, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = scheduler.createItem({
      name: 'Reentrancy test',
      prompt: 'do the thing',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
    });

    // Reach into the private fire() method to simulate two overlapping timer
    // callbacks for the same item firing back-to-back (e.g. the missed-run
    // 5s-delay path and a freshly-armed timer landing at the same tick).
    const fire = (scheduler as unknown as { fire: (i: ScheduledItem) => Promise<void> }).fire.bind(
      scheduler,
    );

    const p1 = fire(item);
    const p2 = fire(item);
    await Promise.all([p1, p2]);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });
});

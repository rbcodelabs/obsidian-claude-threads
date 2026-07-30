import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, computeNextRun, type SchedulerOptions } from '../../src/Scheduler';
import type { ScheduledItem } from '../../src/types';

// Regression coverage for the ScheduleWakeup reliability fix: ScheduleWakeup
// used to arm a bare window.setTimeout tracked only in an in-memory Map on
// the plugin instance. Any plugin reload, Obsidian restart, or app quit
// destroyed the timer silently and permanently (see main.ts onunload, which
// used to clearTimeout every pending wake-up with no persistence). This left
// ScheduleWakeup fundamentally unreliable for anything that needed to survive
// a restart or a Mac sleep, unlike the Cron tools which are backed by this
// same durable Scheduler.
//
// ScheduleWakeup is now implemented as a one-shot ('once') ScheduledItem
// created via Scheduler.createItem, targeting the calling thread. These
// tests exercise the 'once' schedule type directly: it must fire exactly
// once, self-delete afterward (no accumulation of fired wake-ups in
// CronList), and — the core durability property — survive a simulated
// plugin reload by catching up on a fresh Scheduler instance loading the
// same on-disk state, exactly like Cron items already do.
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

/** A tiny mutable in-memory "disk" — stands in for data.json across a simulated reload. */
function makeSharedDisk(initial: ScheduledItem[] = []) {
  let items = initial.map((i) => ({ ...i }));
  return {
    read: (): ScheduledItem[] => items.map((i) => ({ ...i })),
    write: (next: ScheduledItem[]): void => {
      items = next.map((i) => ({ ...i }));
    },
  };
}

describe('computeNextRun — once schedule type', () => {
  it('returns the fixed fireAt regardless of fromNow', () => {
    const fireAt = Date.now() + 60_000;
    const item: ScheduledItem = {
      id: 'w1',
      name: 'Wakeup: check CI',
      prompt: 'check CI status',
      schedule: { type: 'once', fireAt },
      enabled: true,
    };
    expect(computeNextRun(item)).toBe(fireAt);
    expect(computeNextRun(item, true)).toBe(fireAt);
  });

  it('falls back to now if fireAt is missing, rather than defaulting to +1 day like unknown types', () => {
    const before = Date.now();
    const item: ScheduledItem = {
      id: 'w2',
      name: 'Wakeup: no fireAt',
      prompt: 'x',
      schedule: { type: 'once' },
      enabled: true,
    };
    const result = computeNextRun(item);
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThan(before + 1000);
  });
});

describe('Scheduler — once items fire exactly once and self-delete', () => {
  it('fires at fireAt, sends the prompt, then removes itself instead of rearming', async () => {
    const removeItem = vi.fn().mockResolvedValue(undefined);
    const { options, sendMessage, createThread } = makeOptions({ removeItem });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    const item = await scheduler.createItem({
      name: 'Wakeup: checking deploy status',
      prompt: '/loop check-deploy',
      schedule: { type: 'once', fireAt: Date.now() + 30_000 },
      enabled: true,
      targetThreadId: 'thread-1',
      origin: 'wakeup',
    });

    // threadExists defaults to falsy (option not provided), so it falls back
    // to creating a new thread — fine for this test, we only care about the
    // once-fires-then-deletes contract.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(createThread).toHaveBeenCalledWith('Wakeup: checking deploy status', '/tmp', undefined, item.id);
    expect(sendMessage).toHaveBeenCalledWith('new-thread', '/loop check-deploy');

    // The defining behavior: it must be gone, not rearmed for a "next cycle".
    expect(scheduler.getItem(item.id)).toBeUndefined();
    expect(removeItem).toHaveBeenCalledWith(item.id);
    expect((scheduler as unknown as { timers: Map<string, number> }).timers.size).toBe(0);

    // Advancing time further must not cause a second fire.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });

  it('sends into the existing target thread (the calling conversation) when it still exists', async () => {
    const { options, sendMessage, createThread } = makeOptions({
      threadExists: (id) => id === 'thread-1',
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    await scheduler.createItem({
      name: 'Wakeup: poll CI',
      prompt: '/loop poll-ci',
      schedule: { type: 'once', fireAt: Date.now() + 5_000 },
      enabled: true,
      targetThreadId: 'thread-1',
      origin: 'wakeup',
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendMessage).toHaveBeenCalledWith('thread-1', '/loop poll-ci');
    expect(createThread).not.toHaveBeenCalled();

    scheduler.destroy();
  });
});

describe('Scheduler — once items survive a simulated plugin reload (the core durability fix)', () => {
  it('a wake-up whose window.setTimeout would have fired during downtime still fires via catch-up on the next instance', async () => {
    // This mirrors the real failure mode being fixed: the old ScheduleWakeup
    // used a bare window.setTimeout that died with the plugin on reload/quit
    // (or during a Mac sleep) with zero record it ever existed. Here, the
    // item's fireAt already passed while "the app was closed" (instance A is
    // destroyed without ever firing, simulating a crash/quit/sleep before the
    // in-memory timer could elapse) — the on-disk nextRun is what instance B
    // must recover from.
    const fireAt = Date.now() - 10_000; // already overdue when instance B loads it
    const item: ScheduledItem = {
      id: 'wakeup-durable',
      name: 'Wakeup: checking deploy status',
      prompt: '/loop check-deploy',
      schedule: { type: 'once', fireAt },
      enabled: true,
      targetThreadId: 'thread-1',
      origin: 'wakeup',
      nextRun: fireAt,
    };

    const disk = makeSharedDisk([item]);
    const sendMessageA = vi.fn().mockResolvedValue(undefined);
    const sendMessageB = vi.fn().mockResolvedValue(undefined);

    const makeInstanceOptions = (sendMessage: ReturnType<typeof vi.fn>): SchedulerOptions => ({
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
      createThread: vi.fn().mockReturnValue({ id: 'fallback-thread' }),
      sendMessage,
      getDefaultCwd: () => '/tmp',
      threadExists: (id) => id === 'thread-1',
    });

    // Instance A: constructed, but represents the app being killed/reloaded
    // before its setTimeout (or the equivalent real window.setTimeout in the
    // old implementation) ever gets a chance to run. We destroy it
    // immediately without advancing timers — nothing should have fired.
    const schedulerA = new Scheduler(makeInstanceOptions(sendMessageA));
    schedulerA.start([item]);
    schedulerA.destroy();
    expect(sendMessageA).not.toHaveBeenCalled();

    // Instance B: the next plugin load (after restart/reload/wake), reading
    // the SAME on-disk item. Because fireAt/nextRun is a persisted absolute
    // timestamp — not a live in-memory countdown — start() detects it's
    // overdue and catches it up shortly after boot instead of losing it.
    const schedulerB = new Scheduler(makeInstanceOptions(sendMessageB));
    schedulerB.start(disk.read());

    // Catch-up fires after a short deterministic delay (see
    // CATCHUP_BASE_DELAY_MS in Scheduler.ts), not instantly and not never.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendMessageB).toHaveBeenCalledWith('thread-1', '/loop check-deploy');
    // And it must have cleaned itself up afterward — gone from disk, not
    // stuck retrying forever.
    expect(disk.read().find((i) => i.id === 'wakeup-durable')).toBeUndefined();

    schedulerB.destroy();
  });
});

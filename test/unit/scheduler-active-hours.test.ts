/**
 * scheduler-active-hours.test.ts
 *
 * Coverage for the `schedule.activeHours` local-time gating feature: a
 * ScheduledItem can be scoped to a "HH:MM"-"HH:MM" window so cycles that come
 * due outside it are skipped entirely (no thread created, no message sent)
 * instead of firing a thread just to have the prompt itself check the clock
 * and bail. This replaces prompts that used to encode their own "is it
 * business hours?" gate (see the Jarvis Gmail Triage cron item).
 *
 * Two layers are tested:
 *  - isWithinActiveHours: pure boundary/overnight-wrap logic, no timers needed.
 *  - Scheduler.fire(): end-to-end behavior — skipped cycles must not create a
 *    thread, must leave lastRun untouched, and must reschedule nextRun to the
 *    next window-open time; in-window cycles must fire normally.
 *
 * Scheduler uses window.setTimeout/clearTimeout; alias window to globalThis so
 * vitest's fake timers are what the scheduler arms (mirrors the other
 * scheduler-*.test.ts files).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, isWithinActiveHours, type SchedulerOptions } from '../../src/Scheduler';
import type { ScheduledItem, ScheduledItemSchedule } from '../../src/types';

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
  saveItem: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const createThread = vi.fn().mockReturnValue({ id: 'new-thread' });
  const saveItem = vi.fn().mockResolvedValue(undefined);
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem,
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread,
    sendMessage,
    getDefaultCwd: () => '/tmp',
    ...overrides,
  };
  return { options, sendMessage, createThread, saveItem };
}

// ── isWithinActiveHours: pure boundary logic ────────────────────────────────

describe('isWithinActiveHours', () => {
  const schedule = (activeHours?: { start: string; end: string }): ScheduledItemSchedule => ({
    type: 'interval',
    intervalSeconds: 3600,
    activeHours,
  });

  it('is unrestricted when no activeHours is configured', () => {
    expect(isWithinActiveHours(schedule(undefined), new Date(2024, 0, 1, 3, 0).getTime())).toBe(true);
  });

  it('normal same-day window: inside, before-start, and at/after-end (exclusive)', () => {
    const s = schedule({ start: '07:00', end: '22:00' });
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 8, 0).getTime())).toBe(true);
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 7, 0).getTime())).toBe(true); // start is inclusive
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 6, 59).getTime())).toBe(false);
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 21, 59).getTime())).toBe(true);
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 22, 0).getTime())).toBe(false); // end is exclusive
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 0, 0).getTime())).toBe(false);
  });

  it('overnight window (start > end) wraps past midnight', () => {
    const s = schedule({ start: '22:00', end: '06:00' });
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 23, 0).getTime())).toBe(true);
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 5, 0).getTime())).toBe(true);
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 6, 0).getTime())).toBe(false); // end exclusive
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 12, 0).getTime())).toBe(false);
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 22, 0).getTime())).toBe(true); // start inclusive
  });

  it('a zero-width window (start === end) is treated as unrestricted, not "never fires"', () => {
    const s = schedule({ start: '09:00', end: '09:00' });
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 3, 0).getTime())).toBe(true);
    expect(isWithinActiveHours(s, new Date(2024, 0, 1, 9, 0).getTime())).toBe(true);
  });
});

// ── Scheduler.fire(): end-to-end gating ─────────────────────────────────────

describe('Scheduler active-hours gating in fire()', () => {
  it('skips a cycle due outside the window: no thread, lastRun untouched, nextRun jumps to window open', async () => {
    vi.setSystemTime(new Date(2024, 0, 1, 1, 0, 0)); // 01:00 — outside 07:00-22:00

    const item: ScheduledItem = {
      id: 'jarvis-triage',
      name: 'Jarvis Gmail Triage',
      prompt: 'run triage',
      schedule: { type: 'interval', intervalSeconds: 21600, activeHours: { start: '07:00', end: '22:00' } },
      enabled: true,
      nextRun: Date.now() - 1_000, // already overdue so armTimer takes the catch-up path
    };

    const { options, sendMessage, createThread, saveItem } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    // Catch-up base delay is 5s.
    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const saved = scheduler.getItem('jarvis-triage');
    expect(saved?.lastRun).toBeUndefined();
    expect(saved?.nextRun).toBe(new Date(2024, 0, 1, 7, 0, 0, 0).getTime());
    expect(saveItem).toHaveBeenCalled();

    scheduler.destroy();
  });

  it('fires normally when the due cycle falls inside the window', async () => {
    vi.setSystemTime(new Date(2024, 0, 1, 8, 0, 0)); // 08:00 — inside 07:00-22:00

    const item: ScheduledItem = {
      id: 'jarvis-triage',
      name: 'Jarvis Gmail Triage',
      prompt: 'run triage',
      schedule: { type: 'interval', intervalSeconds: 21600, activeHours: { start: '07:00', end: '22:00' } },
      enabled: true,
      nextRun: Date.now() - 1_000,
    };

    const { options, sendMessage, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const saved = scheduler.getItem('jarvis-triage');
    expect(saved?.lastRun).toBeDefined();

    scheduler.destroy();
  });

  it('an overnight window skip jumps nextRun to the next start-of-window, not the raw interval math', async () => {
    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0)); // noon — outside a 22:00-06:00 window

    const item: ScheduledItem = {
      id: 'overnight-job',
      name: 'Overnight-only job',
      prompt: 'do overnight thing',
      schedule: { type: 'interval', intervalSeconds: 3600, activeHours: { start: '22:00', end: '06:00' } },
      enabled: true,
      nextRun: Date.now() - 1_000,
    };

    const { options, sendMessage, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const saved = scheduler.getItem('overnight-job');
    expect(saved?.nextRun).toBe(new Date(2024, 0, 1, 22, 0, 0, 0).getTime());

    scheduler.destroy();
  });

  it('an item with no activeHours configured is unaffected (existing behavior)', async () => {
    vi.setSystemTime(new Date(2024, 0, 1, 1, 0, 0)); // 01:00, would be "outside hours" if gated

    const item: ScheduledItem = {
      id: 'no-gate',
      name: 'Ungated job',
      prompt: 'run always',
      schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true,
      nextRun: Date.now() - 1_000,
    };

    const { options, sendMessage, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });
});

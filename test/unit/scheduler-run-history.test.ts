/**
 * scheduler-run-history.test.ts
 *
 * Coverage for the per-item run history: Scheduler.fire() appends a RunEvent to
 * item.runHistory on every completed cycle so the Settings view can show whether
 * a (gated) job has been firing or skipping over time — unlike the last* fields
 * which only reflect the single most recent cycle.
 *
 * Outcomes recorded:
 *  - 'fired'                → thread created/reused, prompt sent
 *  - 'skipped-gate'         → gate returned a clean non-zero exit
 *  - 'skipped-active-hours' → cycle came due outside the active-hours window
 *  - 'error'                → thread creation / send threw
 * Plus: a gate that could not be evaluated but fired open is a 'fired' outcome
 * annotated with a note, and the buffer is capped at RUN_HISTORY_MAX (ring).
 *
 * Mirrors scheduler-gate.test.ts: a fake runGate is injected and fire() is
 * driven through vitest fake timers via the catch-up path (nextRun in the past
 * → armTimer fires after the 5s catch-up base delay). window is aliased to
 * globalThis so the scheduler's setTimeout is the faked one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, recordRunEvent, RUN_HISTORY_MAX, type SchedulerOptions } from '../../src/Scheduler';
import type { ScheduledItem, RunEvent } from '../../src/types';

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

type GateResult = { exitCode: number | null; stdout: string; timedOut: boolean; spawnError?: string };

function makeOptions(overrides: Partial<SchedulerOptions> = {}): {
  options: SchedulerOptions;
  sendMessage: ReturnType<typeof vi.fn>;
  createThread: ReturnType<typeof vi.fn>;
  saveItem: ReturnType<typeof vi.fn>;
  runGate: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const createThread = vi.fn().mockReturnValue({ id: 'new-thread' });
  const saveItem = vi.fn().mockResolvedValue(undefined);
  const runGate = vi.fn<
    (command: string, opts: { cwd: string; timeoutMs: number; env: Record<string, string | undefined> }) => Promise<GateResult>
  >().mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem,
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread,
    sendMessage,
    getDefaultCwd: () => '/tmp',
    runGate,
    ...overrides,
  };
  return { options, sendMessage, createThread, saveItem, runGate };
}

function item(overrides: Partial<ScheduledItem> = {}): ScheduledItem {
  return {
    id: 'item-1',
    name: 'Job',
    prompt: 'do the work',
    schedule: { type: 'interval', intervalSeconds: 3600 },
    enabled: true,
    nextRun: Date.now() - 1_000, // overdue → catch-up path
    ...overrides,
  };
}

// ── recordRunEvent: pure ring-buffer logic ──────────────────────────────────

describe('recordRunEvent', () => {
  it('appends events oldest-first, most recent last', () => {
    const it0: ScheduledItem = item();
    recordRunEvent(it0, { ts: 1, outcome: 'fired' });
    recordRunEvent(it0, { ts: 2, outcome: 'skipped-gate', gateExitCode: 1 });
    expect(it0.runHistory).toEqual([
      { ts: 1, outcome: 'fired' },
      { ts: 2, outcome: 'skipped-gate', gateExitCode: 1 },
    ]);
  });

  it('caps the buffer at RUN_HISTORY_MAX, dropping the oldest entries', () => {
    const it0: ScheduledItem = item();
    for (let i = 0; i < RUN_HISTORY_MAX + 10; i++) {
      recordRunEvent(it0, { ts: i, outcome: 'fired' });
    }
    expect(it0.runHistory).toHaveLength(RUN_HISTORY_MAX);
    // The oldest 10 were dropped; the buffer starts at ts=10 and ends at the last.
    expect(it0.runHistory![0].ts).toBe(10);
    expect(it0.runHistory![RUN_HISTORY_MAX - 1].ts).toBe(RUN_HISTORY_MAX + 9);
  });
});

// ── fire(): outcome recording ───────────────────────────────────────────────

describe('Scheduler.fire run-history recording', () => {
  it('records a fired outcome with the thread id when the cycle fires', async () => {
    const { options } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([item()]);

    await vi.advanceTimersByTimeAsync(6_000);

    const hist = scheduler.getItem('item-1')?.runHistory;
    expect(hist).toHaveLength(1);
    expect(hist![0].outcome).toBe('fired');
    expect(hist![0].threadId).toBe('new-thread');
    expect(hist![0].ts).toBe(scheduler.getItem('item-1')?.lastRun);

    scheduler.destroy();
  });

  it('records a skipped-gate outcome with the exit code on a clean non-zero gate exit', async () => {
    const runGate = vi.fn().mockResolvedValue({ exitCode: 3, stdout: '', timedOut: false });
    const { options, createThread } = makeOptions({ runGate });
    const scheduler = new Scheduler(options);
    scheduler.start([item({ gate: { command: 'check.sh' } })]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).not.toHaveBeenCalled();
    const hist = scheduler.getItem('item-1')?.runHistory;
    expect(hist).toHaveLength(1);
    expect(hist![0].outcome).toBe('skipped-gate');
    expect(hist![0].gateExitCode).toBe(3);
    expect(hist![0].threadId).toBeUndefined();

    scheduler.destroy();
  });

  it('records a skipped-active-hours outcome when the cycle is outside the window', async () => {
    vi.setSystemTime(new Date(2024, 0, 1, 1, 0, 0)); // 01:00 — outside 07:00-22:00
    const { options, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([
      item({
        schedule: { type: 'interval', intervalSeconds: 21600, activeHours: { start: '07:00', end: '22:00' } },
        nextRun: Date.now() - 1_000,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).not.toHaveBeenCalled();
    const hist = scheduler.getItem('item-1')?.runHistory;
    expect(hist).toHaveLength(1);
    expect(hist![0].outcome).toBe('skipped-active-hours');

    scheduler.destroy();
  });

  it('records an error outcome with the message when firing throws', async () => {
    const createThread = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const { options } = makeOptions({ createThread });
    const scheduler = new Scheduler(options);
    scheduler.start([item()]);

    await vi.advanceTimersByTimeAsync(6_000);

    const hist = scheduler.getItem('item-1')?.runHistory;
    expect(hist).toHaveLength(1);
    expect(hist![0].outcome).toBe('error');
    expect(hist![0].note).toContain('boom');

    scheduler.destroy();
  });

  it('records a fired outcome annotated with a note when a gate errors but fires open', async () => {
    const runGate = vi.fn().mockResolvedValue({ exitCode: null, stdout: '', timedOut: true });
    const { options, createThread } = makeOptions({ runGate });
    const scheduler = new Scheduler(options);
    // failOpen defaults to true → a timed-out gate still fires.
    scheduler.start([item({ gate: { command: 'slow.sh' } })]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    const hist = scheduler.getItem('item-1')?.runHistory;
    expect(hist).toHaveLength(1);
    expect(hist![0].outcome).toBe('fired');
    expect(hist![0].note).toMatch(/fired open despite gate error/i);

    scheduler.destroy();
  });

  it('accumulates history across multiple cycles (fire, then gate-skip)', async () => {
    // First cycle fires (default gate exit 0); flip the gate to skip for the second.
    const runGate = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', timedOut: false });
    const { options } = makeOptions({ runGate });
    const scheduler = new Scheduler(options);
    scheduler.start([item({ gate: { command: 'check.sh' } })]);

    await vi.advanceTimersByTimeAsync(6_000); // cycle 1: fire
    await vi.advanceTimersByTimeAsync(3600 * 1000); // cycle 2: gate-skip

    const hist = scheduler.getItem('item-1')?.runHistory as RunEvent[];
    expect(hist.map((e) => e.outcome)).toEqual(['fired', 'skipped-gate']);

    scheduler.destroy();
  });
});

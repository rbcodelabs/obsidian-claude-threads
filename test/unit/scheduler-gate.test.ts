/**
 * scheduler-gate.test.ts
 *
 * Coverage for the `gate` pre-check feature: a ScheduledItem can carry a
 * deterministic shell command that runs before it fires. Exit 0 fires the agent
 * (and the gate's stdout is folded into the prompt); any clean non-zero exit
 * skips the cycle entirely (no thread, no message) while still advancing the
 * schedule as a completed cycle. A gate that cannot be evaluated (timeout or
 * spawn failure) fails open by default (fires) unless failOpen is false.
 *
 * This mirrors scheduler-active-hours.test.ts: a fake runGate is injected and
 * fire() is driven through vitest fake timers via the catch-up path (nextRun in
 * the past → armTimer fires after the 5s catch-up base delay).
 *
 * Scheduler uses window.setTimeout/clearTimeout; alias window to globalThis so
 * vitest's fake timers are what the scheduler arms (mirrors the other
 * scheduler-*.test.ts files).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, interpolateGateOutput, type SchedulerOptions } from '../../src/Scheduler';
import type { ScheduledItem } from '../../src/types';

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
  // Default gate: fire with no stdout.
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
    getGateBaseEnv: () => ({ env: { BASE_ENV: 'yes' }, sensitiveValues: [] }),
    ...overrides,
  };
  return { options, sendMessage, createThread, saveItem, runGate };
}

function gatedItem(overrides: Partial<ScheduledItem> = {}): ScheduledItem {
  return {
    id: 'gated-item',
    name: 'Gated job',
    prompt: 'do the work',
    schedule: { type: 'interval', intervalSeconds: 3600 },
    enabled: true,
    nextRun: Date.now() - 1_000, // overdue → catch-up path
    gate: { command: 'check.sh' },
    ...overrides,
  };
}

// ── interpolateGateOutput: pure prompt-folding logic ────────────────────────

describe('interpolateGateOutput', () => {
  it('replaces every {{gateOutput}} placeholder with the trimmed stdout', () => {
    const out = interpolateGateOutput('before {{gateOutput}} and {{gateOutput}} end', '  2 new items\n');
    expect(out).toBe('before 2 new items and 2 new items end');
  });

  it('substitutes an empty string for the placeholder when stdout is blank, so the token never leaks', () => {
    expect(interpolateGateOutput('prompt {{gateOutput}}!', '   \n')).toBe('prompt !');
  });

  it('appends a delimited block when there is no placeholder and stdout is non-empty', () => {
    expect(interpolateGateOutput('run triage', 'found 3')).toBe('run triage\n\n---\nGate output:\nfound 3');
  });

  it('leaves the prompt unchanged when stdout is empty and there is no placeholder', () => {
    expect(interpolateGateOutput('run triage', '')).toBe('run triage');
  });

  it('truncates stdout to the ~8 KB cap and appends a truncation marker', () => {
    const big = 'x'.repeat(20_000);
    const out = interpolateGateOutput('{{gateOutput}}', big);
    expect(out).toContain('[gate output truncated]');
    // Byte length of the retained content must not exceed the cap (plus marker).
    expect(out.length).toBeLessThan(9_000);
  });
});

// ── Scheduler.fire(): gate gating end-to-end ────────────────────────────────

describe('Scheduler gate gating in fire()', () => {
  it('exit 0: creates a thread, sends the prompt, records lastGateExitCode 0', async () => {
    const item = gatedItem();
    const { options, sendMessage, createThread, runGate } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('new-thread', 'do the work');

    const saved = scheduler.getItem('gated-item');
    expect(saved?.lastGateExitCode).toBe(0);
    expect(saved?.lastSkipReason).toBeUndefined();
    expect(saved?.lastRun).toBeDefined();

    scheduler.destroy();
  });

  it('clean non-zero exit: no thread, no message, but the cycle still advances and rearms', async () => {
    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0));
    const item = gatedItem();
    const runGate = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', timedOut: false });
    const { options, sendMessage, createThread, saveItem } = makeOptions({ runGate });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(runGate).toHaveBeenCalledTimes(1);
    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const saved = scheduler.getItem('gated-item');
    // A skipped gate cycle is a completed cycle: lastRun advances (set at fire
    // time), nextRun moves one interval out from it, and lastSkipReason records
    // why it was skipped.
    expect(saved?.lastRun).toBeDefined();
    expect(saved?.nextRun).toBe((saved!.lastRun as number) + 3600 * 1000);
    expect(saved?.lastSkipReason).toBe('gate');
    expect(saved?.lastGateExitCode).toBe(1);
    expect(saveItem).toHaveBeenCalled();

    scheduler.destroy();
  });

  it('exit 75 is indeterminate and fails open by default with a persisted diagnostic', async () => {
    const item = gatedItem();
    const { options, createThread, sendMessage } = makeOptions({
      runGate: vi.fn().mockResolvedValue({
        exitCode: 75,
        stdout: 'must not persist',
        stderr: 'HTTP 401 Unauthorized',
        timedOut: false,
      }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const saved = scheduler.getItem('gated-item');
    expect(saved?.lastGateExitCode).toBe(75);
    expect(saved?.lastGateError).toContain('HTTP 401 Unauthorized');
    expect(JSON.stringify(saved)).not.toContain('must not persist');
    expect(saved?.runHistory?.[0]).toMatchObject({
      outcome: 'fired',
      gateExitCode: 75,
    });
    expect(saved?.runHistory?.[0]?.note).toContain('HTTP 401 Unauthorized');

    scheduler.destroy();
  });

  it('exit 75 honors failOpen:false and records the diagnostic on the skipped event', async () => {
    const item = gatedItem({ gate: { command: 'check.sh', failOpen: false } });
    const { options, createThread, sendMessage } = makeOptions({
      runGate: vi.fn().mockResolvedValue({
        exitCode: 75,
        stdout: '',
        stderr: 'invalid feedback count',
        timedOut: false,
      }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const saved = scheduler.getItem('gated-item');
    expect(saved?.lastGateExitCode).toBe(75);
    expect(saved?.lastGateError).toContain('invalid feedback count');
    expect(saved?.runHistory?.[0]).toMatchObject({
      outcome: 'skipped-gate',
      gateExitCode: 75,
    });
    expect(saved?.runHistory?.[0]?.note).toContain('invalid feedback count');

    scheduler.destroy();
  });

  it('clears an indeterminate diagnostic after a later deliberate empty-queue skip', async () => {
    const runGate = vi.fn()
      .mockResolvedValueOnce({ exitCode: 75, stdout: '', stderr: 'HTTP 401', timedOut: false })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: false });
    const { options } = makeOptions({ runGate });
    const scheduler = new Scheduler(options);
    scheduler.start([gatedItem()]);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(scheduler.getItem('gated-item')?.lastGateError).toContain('HTTP 401');

    await vi.advanceTimersByTimeAsync(3600 * 1000);
    const saved = scheduler.getItem('gated-item');
    expect(saved?.lastGateExitCode).toBe(1);
    expect(saved?.lastGateError).toBeUndefined();
    expect(saved?.lastSkipReason).toBe('gate');

    scheduler.destroy();
  });

  it('exit 0 with stdout: substitutes {{gateOutput}} in the prompt sent to the agent', async () => {
    const item = gatedItem({ prompt: 'Process these:\n{{gateOutput}}' });
    const { options, sendMessage } = makeOptions({
      runGate: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '2 new PRs', timedOut: false }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(sendMessage).toHaveBeenCalledWith('new-thread', 'Process these:\n2 new PRs');

    scheduler.destroy();
  });

  it('exit 0 with stdout and no placeholder: appends a Gate output block to the prompt', async () => {
    const item = gatedItem({ prompt: 'run triage' });
    const { options, sendMessage } = makeOptions({
      runGate: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'inbox: 5', timedOut: false }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(sendMessage).toHaveBeenCalledWith('new-thread', 'run triage\n\n---\nGate output:\ninbox: 5');

    scheduler.destroy();
  });

  it('exit 0 with oversized stdout: truncates before interpolating into the prompt', async () => {
    const item = gatedItem({ prompt: '{{gateOutput}}' });
    const { options, sendMessage } = makeOptions({
      runGate: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'y'.repeat(20_000), timedOut: false }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    const sentPrompt = (sendMessage.mock.calls[0]?.[1] ?? '') as string;
    expect(sentPrompt).toContain('[gate output truncated]');
    expect(sentPrompt.length).toBeLessThan(9_000);

    scheduler.destroy();
  });

  it('fail-open by default: a timeout still fires and records lastGateError', async () => {
    const item = gatedItem();
    const { options, createThread, sendMessage } = makeOptions({
      runGate: vi.fn().mockResolvedValue({ exitCode: null, stdout: '', stderr: 'partial timeout detail', timedOut: true }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const saved = scheduler.getItem('gated-item');
    expect(saved?.lastGateError).toMatch(/timed out/i);
    expect(saved?.lastGateError).toContain('partial timeout detail');
    expect(saved?.lastSkipReason).toBeUndefined();

    scheduler.destroy();
  });

  it('fail-open by default: a spawn failure still fires and records lastGateError', async () => {
    const item = gatedItem();
    const { options, createThread } = makeOptions({
      runGate: vi.fn().mockResolvedValue({
        exitCode: null,
        stdout: '',
        stderr: 'spawn diagnostic',
        timedOut: false,
        spawnError: 'command not found',
      }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    const saved = scheduler.getItem('gated-item');
    expect(saved?.lastGateError).toContain('command not found');
    expect(saved?.lastGateError).toContain('spawn diagnostic');

    scheduler.destroy();
  });

  it('failOpen:false, timeout: skips the cycle and records lastGateError', async () => {
    const item = gatedItem({ gate: { command: 'sleep 999', failOpen: false } });
    const { options, createThread, sendMessage } = makeOptions({
      runGate: vi.fn().mockResolvedValue({ exitCode: null, stdout: '', stderr: 'timeout closed', timedOut: true }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const saved = scheduler.getItem('gated-item');
    expect(saved?.lastSkipReason).toBe('gate');
    expect(saved?.lastGateError).toMatch(/timed out/i);
    expect(saved?.lastGateError).toContain('timeout closed');
    expect(saved?.runHistory?.[0]?.note).toContain('timeout closed');
    expect(saved?.lastRun).toBeDefined(); // cycle still advances

    scheduler.destroy();
  });

  it('failOpen:false, spawn failure: skips the cycle', async () => {
    const item = gatedItem({ gate: { command: 'nope', failOpen: false } });
    const { options, createThread, sendMessage } = makeOptions({
      runGate: vi.fn().mockResolvedValue({
        exitCode: null,
        stdout: '',
        stderr: 'spawn closed',
        timedOut: false,
        spawnError: 'not found',
      }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(scheduler.getItem('gated-item')?.lastSkipReason).toBe('gate');
    expect(scheduler.getItem('gated-item')?.lastGateError).toContain('spawn closed');
    expect(scheduler.getItem('gated-item')?.runHistory?.[0]?.note).toContain('spawn closed');

    scheduler.destroy();
  });

  it('runGate not wired (e.g. mobile): a configured gate fails open and fires', async () => {
    const item = gatedItem();
    const { options, createThread, sendMessage } = makeOptions({ runGate: undefined });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });

  it('loop item (targetThreadId) with a gate that skips: reuses no thread and sends no message', async () => {
    const item = gatedItem({ targetThreadId: 'loop-thread', gate: { command: 'check.sh' } });
    const { options, sendMessage, createThread } = makeOptions({
      runGate: vi.fn().mockResolvedValue({ exitCode: 3, stdout: '', timedOut: false }),
      threadExists: () => true,
      isThreadBusy: () => false,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(scheduler.getItem('gated-item')?.lastSkipReason).toBe('gate');

    scheduler.destroy();
  });

  it('loop item (targetThreadId) with a gate that fires: sends the interpolated prompt into the target thread', async () => {
    const item = gatedItem({ targetThreadId: 'loop-thread', prompt: 'loop: {{gateOutput}}', gate: { command: 'check.sh' } });
    const { options, sendMessage, createThread } = makeOptions({
      runGate: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'go', timedOut: false }),
      threadExists: () => true,
      isThreadBusy: () => false,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('loop-thread', 'loop: go');

    scheduler.destroy();
  });

  it('the gate runs only after a won claimFire: a lost claim never invokes runGate', async () => {
    const item = gatedItem();
    const runGate = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
    const { options, createThread, sendMessage } = makeOptions({
      runGate,
      // Simulate another instance having already claimed this cycle.
      claimFire: vi.fn().mockResolvedValue({ claimed: false }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(runGate).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    scheduler.destroy();
  });

  it('passes CRON_LAST_RUN_MS / CRON_ITEM_ID / CRON_ITEM_NAME (and the base env) to runGate', async () => {
    const lastRun = new Date(2024, 0, 1, 9, 0, 0).getTime();
    const item = gatedItem({ id: 'triage-1', name: 'Triage', lastRun, nextRun: Date.now() - 1_000 });
    const runGate = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
    const { options } = makeOptions({
      runGate,
      getGateBaseEnv: () => ({ env: { BASE_ENV: 'yes' }, sensitiveValues: [] }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(runGate).toHaveBeenCalledTimes(1);
    const [command, opts] = runGate.mock.calls[0];
    expect(command).toBe('check.sh');
    expect(opts.cwd).toBe('/tmp');
    expect(opts.timeoutMs).toBe(30 * 1000); // default 30s
    expect(opts.env.CRON_ITEM_ID).toBe('triage-1');
    expect(opts.env.CRON_ITEM_NAME).toBe('Triage');
    expect(opts.env.CRON_LAST_RUN_MS).toBe(String(lastRun));
    expect(opts.env.BASE_ENV).toBe('yes');

    scheduler.destroy();
  });

  it('passes keychain-backed secrets ephemerally without persisting their values', async () => {
    const secret = 'compass-keychain-secret';
    const runGate = vi.fn().mockResolvedValue({
      exitCode: 75,
      stdout: 'failed stdout must not persist',
      stderr: 'HTTP 401 Bearer [REDACTED]',
      timedOut: false,
    });
    const { options } = makeOptions({
      runGate,
      getGateBaseEnv: () => ({
        env: { COMPASS_MCP_API_KEY: secret },
        sensitiveValues: [secret],
      }),
    });
    const scheduler = new Scheduler(options);
    scheduler.start([gatedItem()]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(runGate.mock.calls[0]?.[1]).toMatchObject({
      env: { COMPASS_MCP_API_KEY: secret },
      sensitiveValues: [secret],
    });
    const persisted = JSON.stringify(scheduler.getItem('gated-item'));
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('failed stdout must not persist');
    expect(persisted).toContain('[REDACTED]');

    scheduler.destroy();
  });

  it('caps the gate timeout at the 120s ceiling', async () => {
    const item = gatedItem({ gate: { command: 'check.sh', timeoutSeconds: 9999 } });
    const runGate = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
    const { options } = makeOptions({ runGate });
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(runGate.mock.calls[0][1].timeoutMs).toBe(120 * 1000);

    scheduler.destroy();
  });

  it('an item with no gate configured never invokes runGate (existing behavior)', async () => {
    const item = gatedItem({ gate: undefined });
    const { options, createThread, runGate } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([item]);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(runGate).not.toHaveBeenCalled();
    expect(createThread).toHaveBeenCalledTimes(1);

    scheduler.destroy();
  });
});

// ── createItem / updateItem: gate round-trips and clears ────────────────────

describe('Scheduler gate round-trip through createItem/updateItem', () => {
  it('createItem persists the gate, and updateItem can change a sub-field without disturbing schedule', async () => {
    const { options } = makeOptions();
    const scheduler = new Scheduler(options);

    const created = await scheduler.createItem({
      name: 'Gated',
      prompt: 'p',
      schedule: { type: 'interval', intervalSeconds: 3600, activeHours: { start: '07:00', end: '22:00' } },
      enabled: true,
      gate: { command: 'test -s /tmp/x', timeoutSeconds: 10, failOpen: false },
    });

    expect(created.gate).toEqual({ command: 'test -s /tmp/x', timeoutSeconds: 10, failOpen: false });

    const updated = await scheduler.updateItem(created.id, {
      gate: { command: 'test -s /tmp/x', timeoutSeconds: 45, failOpen: false },
    });
    expect(updated.gate?.timeoutSeconds).toBe(45);
    // schedule (including activeHours) is untouched by a top-level gate patch.
    expect(updated.schedule.intervalSeconds).toBe(3600);
    expect(updated.schedule.activeHours).toEqual({ start: '07:00', end: '22:00' });

    scheduler.destroy();
  });

  it('updateItem with gate:undefined clears the gate without disturbing schedule', async () => {
    const { options } = makeOptions();
    const scheduler = new Scheduler(options);

    const created = await scheduler.createItem({
      name: 'Gated',
      prompt: 'p',
      schedule: { type: 'daily', timeOfDay: '09:00' },
      enabled: true,
      gate: { command: 'check.sh' },
    });
    expect(created.gate).toBeDefined();

    const cleared = await scheduler.updateItem(created.id, { gate: undefined });
    expect(cleared.gate).toBeUndefined();
    expect(cleared.schedule.type).toBe('daily');
    expect(cleared.schedule.timeOfDay).toBe('09:00');

    scheduler.destroy();
  });
});

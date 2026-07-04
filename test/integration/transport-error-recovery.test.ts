/**
 * Integration tests for the "stream closed" transport-error auto-recovery
 * added to ThreadManager.onError (see src/transportErrorRecovery.ts).
 *
 * These exercise ThreadManager.sendMessage() end-to-end against a mocked
 * ClaudeSession — unlike test/unit/transportErrorRecovery.test.ts, which only
 * tests the pure isTransportClosedError/shouldAutoRetryTransportError helpers
 * in isolation. This file verifies the helpers are actually wired correctly
 * into the onError handler: pendingPlan cleanup, status/event transitions,
 * the auto-fired continuation turn, the one-retry-per-thread cap, the
 * fall-through to a real error, and that messages queued during the
 * interrupted turn survive the retry instead of being dropped.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';
import { TRANSPORT_ERROR_CONTINUATION_PROMPT } from '../../src/transportErrorRecovery';

// ─── Shared mock state (mirrors plan-mode-persistence.test.ts pattern, but
// tracks every run() invocation instead of just the latest, since these tests
// drive multiple recursive sendMessage() calls per test) ──────────────────────

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  prompt: null as string | null,
  resolve: null as (() => void) | null,
  runCount: 0,
  prompts: [] as string[],
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      prompt: string,
      _resumeSessionId: string | undefined,
      _cwd: unknown,
      _permissionMode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
    ): Promise<void> {
      mock.callbacks = callbacks;
      mock.prompt = prompt;
      mock.runCount += 1;
      mock.prompts.push(prompt);
      return new Promise<void>((res) => { mock.resolve = res; });
    }
    close() {}
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides: Record<string, unknown> = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

/** Drive the current run to a clean completion and let it resolve. */
async function driveResponse(content: string, sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken(content);
  cb.onMessage(content, []);
  cb.onDone(sessionId, 0.001, 1);
  mock.resolve!();
}

/** Drive the current run to an error and let it resolve (matches real
 *  ClaudeSession behavior: onError fires, then the run() promise settles —
 *  it does not reject). */
function driveError(message: string) {
  mock.callbacks!.onError(new Error(message));
  mock.resolve!();
}

/** Flush pending microtasks so a recursive sendMessage() call (triggered
 *  from inside the onError/onDone handling after the awaited session.run()
 *  resolves) has a chance to actually invoke the mocked session.run() again
 *  before we inspect mock state. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mock.callbacks = null;
  mock.prompt = null;
  mock.resolve = null;
  mock.runCount = 0;
  mock.prompts = [];
});

describe('transport error recovery — onError wiring', () => {
  it('clears a pending plan and emits reconnecting synchronously when a stream-closed error interrupts an ExitPlanMode wait', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((id, e) => { if (id === thread.id) events.push(e); });

    const sendPromise = manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});
    expect(thread.pendingPlan).toBe('My plan');

    mock.callbacks!.onError(new Error('Tool permission stream closed before response received'));

    // These are set synchronously inside the onError callback, before the
    // continuation turn is even fired — no need to flush microtasks.
    expect(thread.pendingPlan).toBeUndefined();
    expect(thread.status).toBe('reconnecting');
    const planClear = events.find(e => e.type === 'pending_plan_changed' && e.planText === undefined);
    expect(planClear).toBeTruthy();
    const reconnecting = events.find(e => e.type === 'reconnecting');
    expect(reconnecting).toBeTruthy();

    // Let the run settle and the auto-fired continuation complete so the test
    // doesn't leave a dangling unresolved promise.
    mock.resolve!();
    await flush();
    await driveResponse('Recovered');
    await sendPromise;
  });

  it('auto-fires exactly one continuation turn with the recovery prompt, then resets the retry budget on clean completion', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    // Establish a resumable session first (mirrors the real repro: the plan
    // wait/error happens well into an existing thread, not on message 1) so
    // thread.sessionId is set and the continuation prompt goes out verbatim
    // with no history preamble prepended.
    const firstTurn = manager.sendMessage(thread.id, 'Hi');
    await driveResponse('First turn done', 'sess-1');
    await firstTurn;
    expect(thread.sessionId).toBe('sess-1');

    const sendPromise = manager.sendMessage(thread.id, 'Now write the plan');
    expect(mock.runCount).toBe(2);

    driveError('Stream closed');
    await flush();

    expect(mock.runCount).toBe(3);
    expect(mock.prompt).toBe(TRANSPORT_ERROR_CONTINUATION_PROMPT);
    expect(thread.streamCloseRetryCount).toBe(1);

    await driveResponse('All good', 'sess-2');
    await sendPromise;

    expect(thread.streamCloseRetryCount).toBe(0);
    expect(thread.status).toBe('waiting');
  });

  it('falls back to a history preamble (not an exact-match prompt) when the very first turn errors before any session was ever established — and that preamble must not misattribute the cause to a cwd change', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    // No prior turn here: thread.sessionId has never been set. This is the
    // exact shape of the original bug report if the plan/ExitPlanMode wait
    // happened to be the thread's first-ever turn.
    const sendPromise = manager.sendMessage(thread.id, 'Enter plan mode and write a plan');
    driveError('Stream closed');
    await flush();

    expect(mock.runCount).toBe(2);
    // The recovery prompt itself must still be present verbatim...
    expect(mock.prompt).toContain(TRANSPORT_ERROR_CONTINUATION_PROMPT);
    // ...but since there was no session to resume, sendMessage() prepends
    // buildHistoryPreamble(). That preamble must not falsely claim the cwd
    // changed — it didn't; the real cause is the transport error retry.
    expect(mock.prompt).not.toContain('the working directory was changed');
    expect(mock.prompt).not.toMatch(/^\[Note: the working directory was changed/);

    await driveResponse('Recovered', 'sess-2');
    await sendPromise;
  });

  it('falls through to a real error once the one-retry budget is spent, without firing a third run', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((id, e) => { if (id === thread.id) events.push(e); });

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    driveError('Stream closed');
    await flush();
    expect(mock.runCount).toBe(2);
    expect(thread.streamCloseRetryCount).toBe(1);

    // Second consecutive transport error on the continuation turn itself.
    driveError('Stream closed');
    await flush();
    await sendPromise;

    expect(mock.runCount).toBe(2); // no third auto-retry
    expect(thread.status).toBe('error');
    expect(thread.lastError).toBe('Stream closed');
    expect(thread.streamCloseRetryCount).toBe(0);
    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
  });

  it('does not auto-retry an unrelated error, regardless of retry count', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    driveError('Claude session ended: error_max_turns');
    await sendPromise;

    expect(mock.runCount).toBe(1);
    expect(thread.status).toBe('error');
    expect(thread.lastError).toBe('Claude session ended: error_max_turns');
  });

  it('preserves messages queued during the interrupted turn and drains them after the continuation completes', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    // Establish a resumable session first so the continuation prompt is an
    // exact match (see the dedicated preamble test above for the no-session case).
    const firstTurn = manager.sendMessage(thread.id, 'Hi');
    await driveResponse('First turn done', 'sess-1');
    await firstTurn;

    const sendPromise = manager.sendMessage(thread.id, 'Now write the plan');
    expect(mock.runCount).toBe(2);

    // Sent while the (mocked) session is still "running" — sendMessage() sees
    // sessions.has(threadId) === true and queues it instead of starting a run.
    await manager.sendMessage(thread.id, 'Queued while erroring');
    expect(manager.getQueuedCount(thread.id)).toBe(1);

    driveError('Stream closed');
    await flush();

    // The retry path must NOT clear the queue (only the final-failure path does).
    expect(mock.runCount).toBe(3);
    expect(mock.prompt).toBe(TRANSPORT_ERROR_CONTINUATION_PROMPT);
    expect(manager.getQueuedCount(thread.id)).toBe(1);

    await driveResponse('Recovered', 'sess-2');
    await flush();

    // Clean completion of the continuation turn should drain the queued message.
    expect(mock.runCount).toBe(4);
    expect(mock.prompts[3]).toBe('Queued while erroring');

    await driveResponse('Handled the queued message', 'sess-3');
    await sendPromise;

    expect(manager.getQueuedCount(thread.id)).toBe(0);
  });
});

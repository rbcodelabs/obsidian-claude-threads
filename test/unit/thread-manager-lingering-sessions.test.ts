/**
 * Tests for ThreadManager's lingering-session bookkeeping (fix/stream-closed-
 * permission-channel): a session whose first `result` has landed (onDone
 * fired, thread looks idle) but whose ClaudeSession.run() hasn't resolved yet
 * — because a background task is still keeping the CLI process alive for a
 * further generation — is tracked in `lingeringSessions` so:
 *   - interrupt() can still reach it (Stop must work during generation 2+)
 *   - sendMessage() gracefully unwinds it (endInput + brief grace period,
 *     hard close() as a fallback) before starting a new session, so two CLI
 *     processes never resume the same session id concurrently.
 *
 * Mocks ClaudeSession itself (not the SDK) so run() can be held open past
 * onDone independently of when it actually resolves, exactly like a
 * background-task-driven multi-generation turn.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';

interface MockClaudeSession {
  callbacks: SessionCallbacks | null;
  resolveRun: (() => void) | null;
  endInputCalls: number;
  closeCalls: number;
  interruptCalls: number;
  onEndInput?: () => void;
  run(...args: unknown[]): Promise<void>;
  endInput(): void;
  close(): void;
  interrupt(): Promise<void>;
}

const mock = vi.hoisted(() => ({
  instances: [] as MockClaudeSession[],
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    callbacks: SessionCallbacks | null = null;
    resolveRun: (() => void) | null = null;
    endInputCalls = 0;
    closeCalls = 0;
    interruptCalls = 0;
    onEndInput?: () => void;
    constructor() {
      mock.instances.push(this as unknown as MockClaudeSession);
    }
    async run(
      _prompt: string,
      _resume: unknown,
      _cwd: unknown,
      _mode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
    ): Promise<void> {
      this.callbacks = callbacks;
      return new Promise<void>((res) => {
        this.resolveRun = res;
      });
    }
    endInput() {
      this.endInputCalls++;
      this.onEndInput?.();
    }
    close() {
      this.closeCalls++;
      this.resolveRun?.();
      this.resolveRun = null;
    }
    async interrupt() {
      this.interruptCalls++;
    }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

beforeEach(() => {
  mock.instances = [];
});

describe('ThreadManager — lingering session tracking', () => {
  it('a session becomes lingering after onDone fires but run() has not resolved', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await Promise.resolve();
    const first = mock.instances[0];
    // First result lands — run() is deliberately NOT resolved yet, simulating
    // a background task still streaming a further generation.
    first.callbacks!.onDone('sess-1', 0.001, 1);

    const lingering = (manager as unknown as { lingeringSessions: Map<string, unknown> }).lingeringSessions;
    expect(lingering.has(thread.id)).toBe(true);
    expect(manager.isRunning(thread.id)).toBe(true);

    // Unwind so the test doesn't leak a pending sendPromise.
    first.close();
    await sendPromise;
  });

  it('interrupt() reaches a lingering session (Stop works during generation 2+)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await Promise.resolve();
    const first = mock.instances[0];
    first.callbacks!.onDone('sess-1', 0.001, 1);

    // No longer in `sessions` (thread looks idle) — interrupt must still
    // find it via lingeringSessions.
    expect(manager.isRunning(thread.id)).toBe(true);
    await manager.interrupt(thread.id);
    expect(first.interruptCalls).toBe(1);

    first.close();
    await sendPromise;
  });

  it('sendMessage() ends a lingering session before starting the next one', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise1 = manager.sendMessage(thread.id, 'Hi');
    await Promise.resolve();
    const first = mock.instances[0];
    // Wire endInput() to simulate the CLI draining and run() resolving shortly after.
    first.onEndInput = () => setTimeout(() => first.resolveRun?.(), 5);
    first.callbacks!.onDone('sess-1', 0.001, 1);

    // Thread now looks idle (no `sessions` entry) but session #1 is lingering.
    // sendMessage() must unwind it (endInput + poll) before starting session #2
    // rather than queuing behind it or resuming the same session id twice.
    const sendPromise2 = manager.sendMessage(thread.id, 'Second message');

    // Give the unwind poll loop (100ms cadence in unwindLingeringSession) time
    // to notice session #1 cleared and for session #2 to be constructed.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    expect(first.endInputCalls).toBe(1);
    expect(mock.instances).toHaveLength(2);
    const second = mock.instances[1];
    expect(second.callbacks).not.toBeNull();

    // Let both sendMessage calls fully unwind so nothing is left pending.
    second.close();
    await Promise.all([sendPromise1, sendPromise2]);
  }, 10_000);

  it('unwindLingeringSession force-closes a session that does not unwind within the timeout', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await Promise.resolve();
    const first = mock.instances[0];
    // Deliberately do NOT resolve run() from endInput() — simulate a hung process.
    first.callbacks!.onDone('sess-1', 0.001, 1);

    const lingering = (manager as unknown as { lingeringSessions: Map<string, unknown> }).lingeringSessions;
    expect(lingering.has(thread.id)).toBe(true);

    await (manager as unknown as {
      unwindLingeringSession(id: string, session: unknown, timeoutMs?: number): Promise<void>;
    }).unwindLingeringSession(thread.id, lingering.get(thread.id), 30);

    expect(first.endInputCalls).toBe(1);
    expect(first.closeCalls).toBe(1);
    expect(lingering.has(thread.id)).toBe(false);

    await sendPromise;
  });
});

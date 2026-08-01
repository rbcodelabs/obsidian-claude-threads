/**
 * Tests for ThreadManager's rate-limit auto-retry path (fix/rate-limit-auto-
 * retry). Unlike the transport-closed retry (which resends a synthetic
 * continuation message, since a tool call may have already gone out),
 * a rate-limit error happens before the turn is processed at all, so the
 * retry must silently replay the exact same turn — no new visible message.
 *
 * Mocks ClaudeSession itself (not the SDK), exactly like
 * thread-manager-lingering-sessions.test.ts and run-state-settled.test.ts.
 * Uses fake timers to fast-forward through the real backoff delays
 * (rateLimitBackoffMs: 3s/8s/20s/45s/90s) without the test actually waiting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import { MAX_RATE_LIMIT_AUTO_RETRIES, rateLimitBackoffMs } from '../../src/rateLimitRecovery';

const RATE_LIMIT_MESSAGE = 'Server is temporarily limiting requests (not your usage limit) · Rate limited';

interface MockClaudeSession {
  callbacks: SessionCallbacks | null;
  resolveRun: (() => void) | null;
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
    endInput() {}
    close() {
      this.resolveRun?.();
      this.resolveRun = null;
    }
    async interrupt() {}
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

beforeEach(() => {
  mock.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThreadManager — rate-limit auto-retry', () => {
  it('(a) emits a rate_limit_retry notice instead of a hard error, and (b) completes with exactly one user + one assistant message after recovering', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    manager.subscribe((_id, e) => events.push(e as { type: string }));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.instances).toHaveLength(1);
    const first = mock.instances[0];

    // First attempt fails with a rate-limit error.
    first.callbacks!.onError(new Error(RATE_LIMIT_MESSAGE));
    first.close(); // simulates run() unwinding after the error, like the real CLI process exiting
    await vi.advanceTimersByTimeAsync(0);

    // (a) No hard error — a reconnecting-style retry notice instead.
    expect(thread.status).toBe('reconnecting');
    expect(thread.lastError).toBeUndefined();
    const retryEvent = events.find((e) => e.type === 'rate_limit_retry');
    expect(retryEvent).toMatchObject({
      type: 'rate_limit_retry',
      attempt: 1,
      maxRetries: MAX_RATE_LIMIT_AUTO_RETRIES,
      delayMs: rateLimitBackoffMs(0),
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(thread.rateLimitRetryCount).toBe(1);

    // Advance past the backoff delay — the same turn silently replays (no new
    // user_message_added event, since it's not a new visible message).
    const eventsBeforeRetry = events.length;
    await vi.advanceTimersByTimeAsync(rateLimitBackoffMs(0));
    expect(mock.instances).toHaveLength(2);
    expect(events.slice(eventsBeforeRetry).some((e) => e.type === 'user_message_added')).toBe(false);

    // Second attempt succeeds.
    const second = mock.instances[1];
    second.callbacks!.onDone('sess-1', 0.001, 1);
    second.close();
    await sendPromise;

    // (b) Exactly one visible user message + one assistant message — no
    // duplicate/synthetic message was added for the silent replay.
    expect(thread.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(thread.status).toBe('waiting');
    expect(thread.rateLimitRetryCount).toBe(0);
  });

  it('(c) falls through to a terminal error with a clean message after exhausting MAX_RATE_LIMIT_AUTO_RETRIES', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    manager.subscribe((_id, e) => events.push(e as { type: string }));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await vi.advanceTimersByTimeAsync(0);

    // Fail MAX_RATE_LIMIT_AUTO_RETRIES + 1 times total — the first
    // MAX_RATE_LIMIT_AUTO_RETRIES failures auto-retry, the one after that
    // must fall through to a terminal error instead of retrying again.
    for (let i = 0; i <= MAX_RATE_LIMIT_AUTO_RETRIES; i++) {
      expect(mock.instances).toHaveLength(i + 1);
      const attempt = mock.instances[i];
      attempt.callbacks!.onError(new Error(RATE_LIMIT_MESSAGE));
      attempt.close();
      await vi.advanceTimersByTimeAsync(0);
      if (i < MAX_RATE_LIMIT_AUTO_RETRIES) {
        expect(thread.status).toBe('reconnecting');
        await vi.advanceTimersByTimeAsync(rateLimitBackoffMs(i));
      }
    }

    await sendPromise;

    // No 6th+1 = 7th retry attempt was spawned.
    expect(mock.instances).toHaveLength(MAX_RATE_LIMIT_AUTO_RETRIES + 1);
    expect(thread.status).toBe('error');
    expect(thread.lastError).toBe(RATE_LIMIT_MESSAGE);
    expect(thread.rateLimitRetryCount).toBe(0);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent as unknown as { error: Error }).error.message).toBe(RATE_LIMIT_MESSAGE);
  });
});

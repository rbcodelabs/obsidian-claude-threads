/**
 * orchestrator-wakeup.test.ts
 *
 * Covers the debounced wake-up ping sent to the orchestrator thread when
 * other threads finish (see src/OrchestratorWakeup.ts). Specifically guards
 * against the regression where the message body dropped the actual thread
 * ids/titles/status — the batch of pending threads must survive from event
 * capture through to the composed message, and `pending` must be snapshotted
 * before it's cleared (clearing first would silently discard the data the
 * message is built from).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorWakeup, type OrchestratorWakeupDeps } from '../../src/OrchestratorWakeup';
import type { ThreadManager, ThreadEvent } from '../../src/ThreadManager';

type Listener = (threadId: string, event: ThreadEvent) => void;

function makeManager(titles: Record<string, string> = {}): {
  manager: ThreadManager;
  emit: (threadId: string, event: ThreadEvent) => void;
} {
  const listeners = new Set<Listener>();
  const manager = {
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getThread: (id: string) => (titles[id] !== undefined ? { id, title: titles[id] } : undefined),
  } as unknown as ThreadManager;

  return {
    manager,
    emit: (threadId, event) => listeners.forEach((l) => l(threadId, event)),
  };
}

function makeDeps(overrides: Partial<OrchestratorWakeupDeps> = {}): {
  deps: OrchestratorWakeupDeps;
  sendMessage: ReturnType<typeof vi.fn>;
  setTimeoutFn: ReturnType<typeof vi.fn>;
  runTimer: () => void;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  let scheduled: (() => void) | null = null;
  const setTimeoutFn = vi.fn((cb: () => void) => {
    scheduled = cb;
    return 'timer-handle';
  });
  const deps: OrchestratorWakeupDeps = {
    getOrchestratorThreadId: () => 'orchestrator-thread',
    threadExists: () => true,
    sendMessage,
    setTimeoutFn,
    clearTimeoutFn: vi.fn(),
    ...overrides,
  };
  return {
    deps,
    sendMessage,
    setTimeoutFn,
    runTimer: () => {
      const cb = scheduled;
      scheduled = null;
      cb?.();
    },
  };
}

describe('OrchestratorWakeup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes the thread id, title, and status for a single finished thread', async () => {
    const { manager, emit } = makeManager({ 'thread-1': 'Fix login bug' });
    const { deps, sendMessage, runTimer } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'done' });
    runTimer();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [threadId, message] = sendMessage.mock.calls[0];
    expect(threadId).toBe('orchestrator-thread');
    expect(message).toBe(
      'New activity on 1 thread — run your review pass.\n- thread-1 "Fix login bug" (done)',
    );
  });

  it('batches multiple threads into one ping with a bullet per thread, preserving id/title/status', async () => {
    const { manager, emit } = makeManager({
      'thread-1': 'Fix login bug',
      'thread-2': 'Update docs',
    });
    const { deps, sendMessage, runTimer } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'done' });
    emit('thread-2', { type: 'error', error: new Error('boom') });
    runTimer();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, message] = sendMessage.mock.calls[0];
    expect(message).toBe(
      [
        'New activity on 2 threads — run your review pass.',
        '- thread-1 "Fix login bug" (done)',
        '- thread-2 "Update docs" (error)',
      ].join('\n'),
    );
  });

  it('falls back to the bare thread id when the title is unavailable', async () => {
    const { manager, emit } = makeManager(); // no titles registered
    const { deps, sendMessage, runTimer } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'done' });
    runTimer();
    await Promise.resolve();

    const [, message] = sendMessage.mock.calls[0];
    expect(message).toBe('New activity on 1 thread — run your review pass.\n- thread-1 (done)');
  });

  it('keeps only the most recent status when a thread fires multiple events before flush', async () => {
    const { manager, emit } = makeManager({ 'thread-1': 'Flaky thread' });
    const { deps, sendMessage, runTimer } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'error', error: new Error('first') });
    emit('thread-1', { type: 'done' });
    runTimer();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, message] = sendMessage.mock.calls[0];
    expect(message).toBe('New activity on 1 thread — run your review pass.\n- thread-1 "Flaky thread" (done)');
  });

  it('clears pending state on flush even if it is empty, and never calls sendMessage', async () => {
    const { manager } = makeManager();
    const { deps, sendMessage, setTimeoutFn } = makeDeps();
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    // No events emitted — timer never armed, nothing to flush.
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips sending and warns when the orchestrator thread no longer exists at flush time', async () => {
    const { manager, emit } = makeManager({ 'thread-1': 'Fix login bug' });
    const onWarn = vi.fn();
    const { deps, sendMessage, runTimer } = makeDeps({ threadExists: () => false, onWarn });
    const wakeup = new OrchestratorWakeup(manager, deps);
    wakeup.start();

    emit('thread-1', { type: 'done' });
    runTimer();
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });
});

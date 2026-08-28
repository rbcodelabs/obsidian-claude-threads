/**
 * Regression tests for the "waiting to resume" UI-visibility bug (fix/
 * scheduled-wakeup-visibility), rewritten for the single-map ThreadSession
 * model (ADR-0002 Stage 2).
 *
 * Original root cause: under the old two-map model,
 * `ThreadManager.isRunning(id)` returned `sessions.has(id) ||
 * lingeringSessions.has(id)`. On `onDone`, the session moved into
 * `lingeringSessions` *before* the `'done'` event was emitted, so
 * `isRunning()` was still true at the moment the UI reacted to `'done'`.
 * `lingeringSessions` only actually cleared once `run()` fully unwound — but
 * no event fired at that point, so nothing told the UI to re-check. The
 * fix was `{ type: 'run_state_settled' }`, emitted right after `run()`
 * unwound, wired into every view that gates wake-up display on `isRunning()`.
 *
 * ADR-0002 Stage 2 removes the two-map design entirely: `isRunning(id)` is
 * now a plain `this.sessions.get(id)?.turnInFlight ?? false` read — no
 * second map, no separate "has run() unwound yet?" question. But a related,
 * narrower race survives in a new shape and is exactly what
 * `emitRunStateSettledWhenIdle()` still guards against (see its doc comment
 * in ThreadManager.ts): `ThreadSession._turnInFlight` flips to `false`
 * *immediately after* `onDone`/`onInterrupted`/`onError` returns, not
 * before — the callback fires first, then `pumpMessages()`'s `case
 * 'result':` handler sets the flag. So a listener reacting SYNCHRONOUSLY to
 * the `'done'`/`'interrupted'`/`'error'` event ThreadManager's own callback
 * emits (inside that same callback, before it returns) would still see
 * `isRunning()` as `true` — the flag hasn't flipped yet. `run_state_settled`
 * is deferred via `queueMicrotask()` specifically so that by the time
 * listeners react to IT, the flip has already happened.
 *
 * These tests exercise the real `ThreadManager` (mocking only `ThreadSession`
 * itself, matching thread-manager-lingering-sessions.test.ts's canonical
 * mock) and small mirrors of the view-layer decision logic that ThreadsView /
 * AgentDashboard / KanbanView apply in their `handleEvent()` switches —
 * mirrors are used because those views are full Obsidian ItemViews not
 * instantiated directly in this suite (see threads-view-cancel-restore.test.ts
 * for the established pattern). Each mirror only recomputes on the exact
 * event types the real `handleEvent()` case lists, so it fails the same way
 * the real UI failed before the fix if `run_state_settled` isn't wired up or
 * isn't emitted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ImageAttachment } from '../../src/types';

// ─── canonical ThreadSession mock (see test/unit/session-message-handlers.test.ts) ──
//
// Critically, this mock preserves the REAL ordering ThreadSession itself
// uses — the wrapped callback runs, THEN turnInFlight flips false — rather
// than flipping the flag first. Getting this order backwards would make
// every test below pass for the wrong reason (or fail to catch a real
// regression in emitRunStateSettledWhenIdle's queueMicrotask deferral).

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  lastKnownSessionId: undefined as string | undefined,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    constructor(_claudePath: string) {}
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.lastKnownSessionId = options.resume;
      const raw = options.callbacks;
      mock.callbacks = {
        ...raw,
        onDone: (sessionId, cost, numTurns) => {
          mock.lastKnownSessionId = sessionId;
          raw.onDone(sessionId, cost, numTurns); // callback fires first...
          this._turnInFlight = false;            // ...flag flips after (real order)
        },
        onInterrupted: (sessionId) => {
          raw.onInterrupted(sessionId);
          this._turnInFlight = false;
        },
        onError: (err) => {
          raw.onError(err);
          this._turnInFlight = false;
        },
      };
    }
    send(_text: string, _images?: ImageAttachment[]): void {
      this._turnInFlight = true;
    }
    async interrupt(): Promise<void> {
      mock.callbacks?.onInterrupted(mock.lastKnownSessionId ?? '');
    }
    async setModel(_model?: string): Promise<void> {}
    async setPermissionMode(_mode: unknown): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');
type ThreadManagerInstance = InstanceType<typeof ThreadManager>;

function makeManager(overrides = {}): ThreadManagerInstance {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

// ── Minimal wake-up registry, mirroring plugin.getPendingWakeups/hasPendingWakeup ──

interface WakeupEntry {
  fireAt: number;
  reason?: string;
}

function makeWakeupStore() {
  const store = new Map<string, WakeupEntry[]>();
  return {
    register(id: string, entry: WakeupEntry): void {
      store.set(id, [...(store.get(id) ?? []), entry]);
    },
    clear(id: string): void {
      store.delete(id);
    },
    hasPending(id: string): boolean {
      return (store.get(id)?.length ?? 0) > 0;
    },
  };
}

/**
 * Mirrors the AgentDashboard/KanbanView bucketing decision (running >
 * waiting > other), wired the same way their handleEvent() switches are:
 * re-partition on 'wakeup_changed' and 'run_state_settled'.
 */
function makeBucketMirror(
  manager: ThreadManagerInstance,
  wakeups: ReturnType<typeof makeWakeupStore>,
  threadId: string,
) {
  let bucket: 'running' | 'waiting' | 'other' = 'other';
  const recompute = () => {
    if (manager.isRunning(threadId)) bucket = 'running';
    else if (wakeups.hasPending(threadId)) bucket = 'waiting';
    else bucket = 'other';
  };
  const unsubscribe = manager.subscribe((id, event) => {
    if (id !== threadId) return;
    if (event.type === 'wakeup_changed' || event.type === 'run_state_settled') {
      recompute();
    }
  });
  recompute();
  return {
    get bucket() { return bucket; },
    unsubscribe,
  };
}

beforeEach(() => {
  mock.callbacks = null;
  mock.lastKnownSessionId = undefined;
});

describe('ThreadManager — run_state_settled (single-session model)', () => {
  it('fires once after onDone, by which point isRunning() is already false', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    const events: string[] = [];
    manager.subscribe((id, event) => {
      if (id === thread.id) events.push(event.type);
    });

    await manager.sendMessage(thread.id, 'Hi');
    expect(manager.isRunning(thread.id)).toBe(true);

    mock.callbacks!.onDone('sess-1', 0.001, 1);

    // queueMicrotask hasn't fired yet on this synchronous tick.
    expect(events).toContain('done');
    expect(events).not.toContain('run_state_settled');

    await Promise.resolve(); // let the queued microtask run
    await Promise.resolve();

    expect(events[events.length - 1]).toBe('run_state_settled');
    expect(manager.isRunning(thread.id)).toBe(false);
    const settledCount = events.filter((t) => t === 'run_state_settled').length;
    expect(settledCount).toBe(1);
  });

  it('regression: isRunning() is still true at the exact synchronous moment the \'done\' event fires — the reason run_state_settled defers via queueMicrotask', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    let isRunningDuringDoneEvent: boolean | null = null;
    manager.subscribe((id, event) => {
      if (id === thread.id && event.type === 'done') {
        isRunningDuringDoneEvent = manager.isRunning(thread.id);
      }
    });

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onDone('sess-1', 0.001, 1);

    // ThreadSession's real ordering: the onDone callback (which emits
    // 'done') runs BEFORE _turnInFlight flips to false. A subscriber
    // reacting to 'done' synchronously must therefore still see isRunning()
    // as true — if this ever reads false, ThreadSession's callback/flag
    // ordering silently inverted and `run_state_settled`'s queueMicrotask
    // deferral (and this file's guarantee that listeners see the SETTLED
    // value) would no longer be necessary/correct.
    expect(isRunningDuringDoneEvent).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('fires after onInterrupted too, not just onDone', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    const events: string[] = [];
    manager.subscribe((id, event) => {
      if (id === thread.id) events.push(event.type);
    });

    await manager.sendMessage(thread.id, 'Hi');
    await manager.interrupt(thread.id);

    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContain('interrupted');
    expect(events).toContain('run_state_settled');
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('fires after onError too', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    const events: string[] = [];
    manager.subscribe((id, event) => {
      if (id === thread.id) events.push(event.type);
    });

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onError(new Error('boom'));

    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContain('error');
    expect(events).toContain('run_state_settled');
    expect(manager.isRunning(thread.id)).toBe(false);
  });
});

describe('AgentDashboard/Kanban "Waiting" bucket — same regression, dashboard side', () => {
  it('moves a thread from Working to Waiting automatically on run_state_settled', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());
    const wakeups = makeWakeupStore();
    const bucketMirror = makeBucketMirror(manager, wakeups, thread.id);

    expect(bucketMirror.bucket).toBe('other');

    await manager.sendMessage(thread.id, 'Hi');

    wakeups.register(thread.id, { fireAt: Date.now() + 60_000 });
    manager.notifyWakeupChanged(thread.id);
    expect(bucketMirror.bucket).toBe('running');

    mock.callbacks!.onDone('sess-1', 0.001, 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(bucketMirror.bucket).toBe('waiting');

    bucketMirror.unsubscribe();
  });
});

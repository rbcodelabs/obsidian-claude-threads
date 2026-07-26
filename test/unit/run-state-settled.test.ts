/**
 * Regression tests for the "waiting to resume" UI-visibility bug (fix/
 * scheduled-wakeup-visibility).
 *
 * Root cause: `ThreadManager.isRunning(id)` returns true for
 * `sessions.has(id) || lingeringSessions.has(id)`. On `onDone`, the session
 * moves into `lingeringSessions` *before* the `'done'` event is emitted, so
 * `isRunning()` is still true at the moment the UI reacts to `'done'`.
 * `lingeringSessions` only actually clears once `run()` fully unwinds — but
 * no event was emitted at that point, so nothing told the UI to re-check.
 * The wake-up banner (and the AgentDashboard/Kanban "Waiting" bucket) stayed
 * stuck showing "running" state until an unrelated event forced a full
 * re-render (e.g. switching threads and back).
 *
 * The fix: emit `{ type: 'run_state_settled' }` right after `run()` unwinds
 * (ThreadManager.ts, immediately after the lingering-cleanup block), and
 * wire every view that gates on `isRunning()` for wake-up display to react
 * to it.
 *
 * These tests exercise the real `ThreadManager` (mocking only `ClaudeSession`
 * itself, exactly like thread-manager-lingering-sessions.test.ts) and small
 * mirrors of the view-layer decision logic that ThreadsView / AgentDashboard
 * / KanbanView apply in their `handleEvent()` switches — mirrors are used
 * because those views are full Obsidian ItemViews not instantiated directly
 * in this suite (see threads-view-cancel-restore.test.ts for the established
 * pattern). Each mirror only recomputes on the exact event types the real
 * `handleEvent()` case lists, so it fails the same way the real UI failed
 * before the fix if `run_state_settled` isn't wired up or isn't emitted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';

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

// ── Mirrors of the view-layer decision logic ────────────────────────────────

/**
 * Mirrors ThreadsView.refreshWakeupBanner()'s visibility decision, wired the
 * same way handleEvent() wires it: recompute only on 'wakeup_changed' and
 * 'run_state_settled' (the exact two cases in the real switch).
 */
function makeWakeupBannerMirror(
  manager: ThreadManagerInstance,
  wakeups: ReturnType<typeof makeWakeupStore>,
  threadId: string,
) {
  let visible = false;
  const recompute = () => {
    visible = wakeups.hasPending(threadId) && !manager.isRunning(threadId);
  };
  const unsubscribe = manager.subscribe((id, event) => {
    if (id !== threadId) return;
    if (event.type === 'wakeup_changed' || event.type === 'run_state_settled') {
      recompute();
    }
  });
  recompute();
  return {
    get visible() { return visible; },
    unsubscribe,
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
  mock.instances = [];
});

describe('ThreadManager — run_state_settled', () => {
  it('is emitted once run() fully unwinds, at which point isRunning() is false', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const events: string[] = [];
    manager.subscribe((id, event) => {
      if (id === thread.id) events.push(event.type);
    });

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await Promise.resolve();
    const session = mock.instances[0];

    // First result lands — session becomes lingering, run() has not resolved.
    session.callbacks!.onDone('sess-1', 0.001, 1);
    expect(manager.isRunning(thread.id)).toBe(true);
    expect(events).toContain('done');
    expect(events).not.toContain('run_state_settled');

    // run() now fully resolves (mirrors the CLI process exiting after a
    // lingering background-task-driven generation finishes).
    session.close();
    await sendPromise;

    expect(events[events.length - 1]).toBe('run_state_settled');
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('is emitted on the fast path too, when there is no lingering session', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const events: string[] = [];
    manager.subscribe((id, event) => {
      if (id === thread.id) events.push(event.type);
    });

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await Promise.resolve();
    const session = mock.instances[0];

    // onDone and the immediate run() resolution both happen before any
    // await yields back to the test — run_state_settled must still land.
    session.callbacks!.onDone('sess-1', 0.001, 1);
    session.close();
    await sendPromise;

    expect(events).toContain('run_state_settled');
    expect(manager.isRunning(thread.id)).toBe(false);
  });
});

describe('wake-up banner visibility — regression for the stuck-until-thread-switch bug', () => {
  it('stays hidden while lingering, then becomes visible automatically on run_state_settled — no extra trigger', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const wakeups = makeWakeupStore();
    const banner = makeWakeupBannerMirror(manager, wakeups, thread.id);

    expect(banner.visible).toBe(false);

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await Promise.resolve();
    const session = mock.instances[0];

    // A wake-up is registered mid-turn, exactly like the ScheduleWakeup MCP
    // tool calling back into the plugin while the thread is still running.
    wakeups.register(thread.id, { fireAt: Date.now() + 60_000, reason: 'check CI status' });
    manager.notifyWakeupChanged(thread.id);
    expect(banner.visible).toBe(false); // still running — must stay hidden

    // The 'done' event fires while the session is lingering. isRunning() is
    // still true at this instant — this is the exact moment the old code
    // reacted to 'done' and left the banner hidden.
    session.callbacks!.onDone('sess-1', 0.001, 1);
    expect(manager.isRunning(thread.id)).toBe(true);
    expect(banner.visible).toBe(false);

    // run() fully unwinds — isRunning() reaches its final settled value.
    // The banner mirror only recomputes on 'wakeup_changed'/'run_state_settled',
    // so this assertion fails unless run_state_settled actually fired here.
    session.close();
    await sendPromise;

    expect(manager.isRunning(thread.id)).toBe(false);
    expect(banner.visible).toBe(true);

    banner.unsubscribe();
  });
});

describe('AgentDashboard/Kanban "Waiting" bucket — same regression, dashboard side', () => {
  it('moves a thread from Working to Waiting automatically on run_state_settled', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const wakeups = makeWakeupStore();
    const bucketMirror = makeBucketMirror(manager, wakeups, thread.id);

    expect(bucketMirror.bucket).toBe('other');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    await Promise.resolve();
    const session = mock.instances[0];

    wakeups.register(thread.id, { fireAt: Date.now() + 60_000 });
    manager.notifyWakeupChanged(thread.id);

    session.callbacks!.onDone('sess-1', 0.001, 1);
    // Still lingering (isRunning() true) — must not have moved to Waiting yet.
    expect(bucketMirror.bucket).not.toBe('waiting');

    session.close();
    await sendPromise;

    expect(bucketMirror.bucket).toBe('waiting');

    bucketMirror.unsubscribe();
  });
});

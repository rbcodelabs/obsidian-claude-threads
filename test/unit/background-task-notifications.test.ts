import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ImageAttachment } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// Hoisted mock state — accessible inside vi.mock factory
const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  prompt: null as string | null,
  model: null as string | undefined,
  images: null as import('../../src/types').ImageAttachment[] | undefined,
  lastKnownSessionId: undefined as string | undefined,
  startCallCount: 0,
  sendCallCount: 0,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    constructor(_claudePath: string) {}
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: ThreadSessionOptions): Promise<void> {
      mock.startCallCount += 1;
      mock.lastKnownSessionId = options.resume;
      mock.model = options.model;
      const raw = options.callbacks;
      mock.callbacks = {
        ...raw,
        onDone: (sessionId, cost, numTurns) => {
          mock.lastKnownSessionId = sessionId;
          raw.onDone(sessionId, cost, numTurns);
          this._turnInFlight = false;
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
    send(text: string, images?: ImageAttachment[]): void {
      mock.sendCallCount += 1;
      mock.prompt = text;
      mock.images = images;
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

// Import AFTER vi.mock so the mock is in place
const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

// Helper: drive a complete successful response through the mock
function driveResponse(content: string, sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken(content);
  cb.onMessage(content, []);
  cb.onDone(sessionId, 0.001, 1);
}

beforeEach(() => {
  mock.callbacks = null;
  mock.prompt = null;
  mock.model = null;
  mock.images = null;
  mock.lastKnownSessionId = undefined;
  mock.startCallCount = 0;
  mock.sendCallCount = 0;
});

// ─── background task tracking — activeBgTasks ────────────────────────────────

describe('background task tracking — activeBgTasks', () => {
  it('task_started with skipTranscript: true emits the event normally', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Run linter in background', true);
    await driveResponse('Done');
    await sendPromise;

    const evt = events.find(e => e.type === 'task_started') as
      { type: 'task_started'; taskId: string; description: string; skipTranscript: boolean } | undefined;
    expect(evt).toBeDefined();
    expect(evt!.taskId).toBe('bg-task-1');
    expect(evt!.description).toBe('Run linter in background');
    expect(evt!.skipTranscript).toBe(true);
  });

  it('non-background task (skipTranscript: false) emits event but is NOT tracked as pending after onDone', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('fg-task-1', 'Foreground task', false);
    await driveResponse('Done');
    await sendPromise;

    // task_started event fires
    const taskStarted = events.find(e => e.type === 'task_started');
    expect(taskStarted).toBeDefined();
    // but background_tasks_pending must NOT fire
    expect(events.find(e => e.type === 'background_tasks_pending')).toBeUndefined();
    // and no pending tasks stored
    expect(manager.getPendingBackgroundTasks(thread.id)).toEqual([]);
  });

  it('task_notification arriving before onDone removes the task — no background_tasks_pending on done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Background job', true);
    // Notification arrives before session ends
    mock.callbacks!.onTaskNotification!('bg-task-1', 'completed', 'Job finished');
    await driveResponse('Done');
    await sendPromise;

    expect(events.find(e => e.type === 'background_tasks_pending')).toBeUndefined();
    expect(manager.getPendingBackgroundTasks(thread.id)).toEqual([]);
  });

  it('task_notification arriving before onDone removes ONLY the notified task when multiple bg tasks are in flight', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Job one', true);
    mock.callbacks!.onTaskStarted!('bg-task-2', 'Job two', true);
    // Only the first task resolves before done
    mock.callbacks!.onTaskNotification!('bg-task-1', 'completed', 'Done');
    await driveResponse('Done');
    await sendPromise;

    const pendingEvt = events.find(e => e.type === 'background_tasks_pending') as
      { type: 'background_tasks_pending'; tasks: import('../../src/types').PendingBackgroundTask[] } | undefined;
    expect(pendingEvt).toBeDefined();
    expect(pendingEvt!.tasks).toHaveLength(1);
    expect(pendingEvt!.tasks[0].taskId).toBe('bg-task-2');
    // bg-task-1 must not appear
    expect(pendingEvt!.tasks.find(t => t.taskId === 'bg-task-1')).toBeUndefined();
  });

  it('session ending with an unresolved bg task emits background_tasks_pending with correct tasks array', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Slow job', true);
    await driveResponse('Done', 'sess-99');
    await sendPromise;

    const pendingEvt = events.find(e => e.type === 'background_tasks_pending') as
      { type: 'background_tasks_pending'; tasks: import('../../src/types').PendingBackgroundTask[] } | undefined;
    expect(pendingEvt).toBeDefined();
    expect(pendingEvt!.tasks).toHaveLength(1);
    expect(pendingEvt!.tasks[0].taskId).toBe('bg-task-1');
    expect(pendingEvt!.tasks[0].description).toBe('Slow job');
    expect(pendingEvt!.tasks[0].pollCount).toBe(0);
    expect(typeof pendingEvt!.tasks[0].startedAt).toBe('number');
  });

  it('background_tasks_pending event is emitted BEFORE the done event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Job', true);
    await driveResponse('Done');
    await sendPromise;

    const types = events.map(e => e.type);
    const pendingIdx = types.indexOf('background_tasks_pending');
    const doneIdx = types.indexOf('done');
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(pendingIdx);
  });

  it('pendingBackgroundTasks is stored on the thread after session ends with an unresolved bg task', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Slow job', true);
    await driveResponse('Done');
    await sendPromise;

    expect(thread.pendingBackgroundTasks).toBeDefined();
    expect(thread.pendingBackgroundTasks).toHaveLength(1);
    expect(thread.pendingBackgroundTasks![0].taskId).toBe('bg-task-1');
  });

  it('multiple unresolved bg tasks all appear in pendingBackgroundTasks', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Job one', true);
    mock.callbacks!.onTaskStarted!('bg-task-2', 'Job two', true);
    mock.callbacks!.onTaskStarted!('bg-task-3', 'Job three', true);
    await driveResponse('Done');
    await sendPromise;

    const pending = thread.pendingBackgroundTasks;
    expect(pending).toHaveLength(3);
    const ids = pending!.map(t => t.taskId);
    expect(ids).toContain('bg-task-1');
    expect(ids).toContain('bg-task-2');
    expect(ids).toContain('bg-task-3');
  });

  it('new session unresolved tasks accumulate with already-persisted tasks (no overwrite)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    // First session leaves bg-task-1 pending
    const p1 = manager.sendMessage(thread.id, 'First');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Session 1 job', true);
    await driveResponse('Done', 'sess-1');
    await p1;

    expect(thread.pendingBackgroundTasks).toHaveLength(1);

    // Second session leaves bg-task-2 pending
    const p2 = manager.sendMessage(thread.id, 'Second');
    mock.callbacks!.onTaskStarted!('bg-task-2', 'Session 2 job', true);
    await driveResponse('Done', 'sess-2');
    await p2;

    // Both tasks must be present — session 1's task must not be overwritten
    const pending = thread.pendingBackgroundTasks;
    expect(pending).toHaveLength(2);
    const ids = pending!.map(t => t.taskId);
    expect(ids).toContain('bg-task-1');
    expect(ids).toContain('bg-task-2');
  });
});

// ─── addNoticeMessage ─────────────────────────────────────────────────────────

describe('addNoticeMessage', () => {
  it('pushes a persisted notice message and emits a message event', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    manager.addNoticeMessage(thread.id, 'completed', 'Subagent finished');

    // Message pushed onto the transcript with the right shape
    expect(thread.messages).toHaveLength(1);
    const msg = thread.messages[0];
    expect(msg.role).toBe('notice');
    expect(msg.content).toBe('Subagent finished');
    expect(msg.noticeStatus).toBe('completed');
    expect(typeof msg.id).toBe('string');
    expect(typeof msg.timestamp).toBe('number');

    // A 'message' event carrying that same message was emitted for live views
    const messageEvt = events.find(e => e.type === 'message') as
      { type: 'message'; message: import('../../src/types').ChatMessage } | undefined;
    expect(messageEvt).toBeDefined();
    expect(messageEvt!.message).toBe(msg);
  });

  it('carries the failed/stopped status through to the message', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    manager.addNoticeMessage(thread.id, 'failed', 'Job crashed');
    expect(thread.messages[0].noticeStatus).toBe('failed');
  });

  it('no-ops for an unknown threadId', () => {
    const manager = makeManager();
    expect(() => manager.addNoticeMessage('nonexistent', 'completed', 'x')).not.toThrow();
  });
});

// ─── getPendingBackgroundTasks ────────────────────────────────────────────────

describe('getPendingBackgroundTasks', () => {
  it('returns [] for a thread with no pending tasks', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    expect(manager.getPendingBackgroundTasks(thread.id)).toEqual([]);
  });

  it('returns the persisted tasks after session ends with bg tasks', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Background job', true);
    await driveResponse('Done');
    await sendPromise;

    const tasks = manager.getPendingBackgroundTasks(thread.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe('bg-task-1');
    expect(tasks[0].description).toBe('Background job');
    expect(tasks[0].pollCount).toBe(0);
  });
});

// ─── clearPendingBackgroundTask ───────────────────────────────────────────────

describe('clearPendingBackgroundTask', () => {
  it('removes the targeted task by taskId', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Job one', true);
    mock.callbacks!.onTaskStarted!('bg-task-2', 'Job two', true);
    await driveResponse('Done');
    await sendPromise;

    manager.clearPendingBackgroundTask(thread.id, 'bg-task-1');

    const tasks = manager.getPendingBackgroundTasks(thread.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe('bg-task-2');
  });

  it('deletes pendingBackgroundTasks entirely when the last task is removed', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Only job', true);
    await driveResponse('Done');
    await sendPromise;

    expect(thread.pendingBackgroundTasks).toBeDefined();

    manager.clearPendingBackgroundTask(thread.id, 'bg-task-1');

    // Property should be deleted entirely, not left as an empty array
    expect(thread.pendingBackgroundTasks).toBeUndefined();
    expect(manager.getPendingBackgroundTasks(thread.id)).toEqual([]);
  });

  it('no-ops for an unknown threadId', () => {
    const manager = makeManager();
    // Must not throw
    expect(() => manager.clearPendingBackgroundTask('nonexistent-thread', 'bg-task-1')).not.toThrow();
  });

  it('no-ops for an unknown taskId on a known thread', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Some job', true);
    await driveResponse('Done');
    await sendPromise;

    // Removing a non-existent task ID must leave existing tasks untouched
    expect(() => manager.clearPendingBackgroundTask(thread.id, 'completely-unknown-task')).not.toThrow();
    expect(manager.getPendingBackgroundTasks(thread.id)).toHaveLength(1);
  });
});

// ─── clearAllPendingBackgroundTasks ──────────────────────────────────────────

describe('clearAllPendingBackgroundTasks', () => {
  it('removes all tasks at once', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Job one', true);
    mock.callbacks!.onTaskStarted!('bg-task-2', 'Job two', true);
    await driveResponse('Done');
    await sendPromise;

    expect(thread.pendingBackgroundTasks).toHaveLength(2);

    manager.clearAllPendingBackgroundTasks(thread.id);

    expect(thread.pendingBackgroundTasks).toBeUndefined();
    expect(manager.getPendingBackgroundTasks(thread.id)).toEqual([]);
  });

  it('no-ops for threads with no pending tasks', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    // Must not throw and must leave state unchanged
    expect(() => manager.clearAllPendingBackgroundTasks(thread.id)).not.toThrow();
    expect(thread.pendingBackgroundTasks).toBeUndefined();
  });
});

// ─── incrementPendingTaskPollCount ────────────────────────────────────────────

describe('incrementPendingTaskPollCount', () => {
  it('increments pollCount on every pending task', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Job one', true);
    mock.callbacks!.onTaskStarted!('bg-task-2', 'Job two', true);
    await driveResponse('Done');
    await sendPromise;

    // All tasks start at pollCount 0
    expect(thread.pendingBackgroundTasks!.every(t => t.pollCount === 0)).toBe(true);

    manager.incrementPendingTaskPollCount(thread.id);
    expect(thread.pendingBackgroundTasks!.every(t => t.pollCount === 1)).toBe(true);

    manager.incrementPendingTaskPollCount(thread.id);
    manager.incrementPendingTaskPollCount(thread.id);
    expect(thread.pendingBackgroundTasks!.every(t => t.pollCount === 3)).toBe(true);
  });

  it('no-ops when no pending tasks exist', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    // Must not throw
    expect(() => manager.incrementPendingTaskPollCount(thread.id)).not.toThrow();
    expect(thread.pendingBackgroundTasks).toBeUndefined();
  });
});

// ─── hasActiveBackgroundTasks — driven through the real event flow ───────────
//
// This is the exact bug scenario the fix targets: the outer turn's onDone
// lands (isRunning() flips false) while a run_in_background Agent call or
// Workflow-tool task (both skipTranscript: true, same task_started/
// task_notification protocol) is still running server-side.

describe('hasActiveBackgroundTasks — event-driven lifecycle', () => {
  // NOTE on ordering: sendMessage() resolves once session.send() has been
  // called (turnInFlight flips true), NOT once onDone fires — mirroring
  // run-state-settled.test.ts's canonical pattern, we `await` the send
  // first so turnInFlight is definitely true before driving onDone
  // ourselves. Interleaving onDone before the send() continuation has run
  // (as some of the other tests above do, since they never assert on
  // isRunning()) races turnInFlight in the opposite, misleading direction.

  it('is true immediately after onTaskStarted, before the outer turn even settles', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    await manager.sendMessage(thread.id, 'Hi');
    expect(manager.isRunning(thread.id)).toBe(true);
    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(false);

    mock.callbacks!.onTaskStarted!('bg-task-1', 'Spawn subagent', true);
    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(true);

    mock.callbacks!.onDone('sess-1', 0.001, 1);
  });

  it('stays true after the outer turn settles (onDone) if the bg task is still unresolved — the bug this fix targets', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Spawn subagent', true);
    mock.callbacks!.onDone('sess-1', 0.001, 1);
    // isRunning() settles asynchronously via a queueMicrotask deferral in
    // emitRunStateSettledWhenIdle (see run-state-settled.test.ts) — it is
    // NOT yet false on the synchronous tick right after onDone.
    await Promise.resolve();
    await Promise.resolve();

    // The outer turn is done — isRunning() is now false — but the background
    // task never notified completion, so the thread must still read as active.
    expect(manager.isRunning(thread.id)).toBe(false);
    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(true);
  });

  it('becomes false once onTaskNotification reports the background task resolved', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Spawn subagent', true);
    mock.callbacks!.onDone('sess-1', 0.001, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(true);

    mock.callbacks!.onTaskNotification!('bg-task-1', 'completed', 'Subagent finished');

    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(false);
    expect(manager.getActiveBackgroundTasks(thread.id)).toEqual([]);
  });

  it('a foreground-only task (skipTranscript: false) never registers as an active background task', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('fg-task-1', 'Foreground task', false);
    mock.callbacks!.onDone('sess-1', 0.001, 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(false);
  });

  it('with two unresolved background tasks, only fully resolves once BOTH notify', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    await manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('bg-task-1', 'Job one', true);
    mock.callbacks!.onTaskStarted!('bg-task-2', 'Job two', true);
    mock.callbacks!.onDone('sess-1', 0.001, 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(true);
    mock.callbacks!.onTaskNotification!('bg-task-1', 'completed', 'Done');
    // Still true — bg-task-2 hasn't notified yet.
    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(true);
    mock.callbacks!.onTaskNotification!('bg-task-2', 'completed', 'Done');
    expect(manager.hasActiveBackgroundTasks(thread.id)).toBe(false);
  });
});

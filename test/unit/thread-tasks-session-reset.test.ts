import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// Hoisted mock state — accessible inside vi.mock factory
const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  resolve: null as (() => void) | null,
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      _prompt: string,
      _resumeSessionId: string | undefined,
      _cwd: unknown,
      _mode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
    ): Promise<void> {
      mock.callbacks = callbacks;
      return new Promise<void>((res) => { mock.resolve = res; });
    }
    close() {}
    async interrupt() {}
  },
}));

// Import AFTER vi.mock so the mock is in place
const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

async function driveResponse(content: string, sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken(content);
  cb.onMessage(content, []);
  cb.onDone(sessionId, 0.001, 1);
  mock.resolve!();
}

beforeEach(() => {
  mock.callbacks = null;
  mock.resolve = null;
});

describe('ThreadManager — task board reset on unresumed new session', () => {
  it('clears stale thread.tasks / pendingBackgroundTasks when starting a fresh session with prior history but no sessionId', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    // Simulate the exact scenario from production: a prior session left
    // behind an incomplete task board and pending background tasks, then
    // something (e.g. a cwd change or a resume failure) cleared sessionId
    // while message history survived.
    thread.messages.push({
      id: 'm1',
      role: 'user',
      content: 'earlier turn',
      timestamp: Date.now(),
    });
    thread.tasks = [
      { id: '1', content: 'Stale leftover task', status: 'in_progress' },
      { id: '2', content: 'Another stale task', status: 'pending' },
    ];
    thread.pendingBackgroundTasks = [
      { taskId: 'bg-1', description: 'stale bg job', startedAt: Date.now(), pollCount: 0 },
    ];
    thread.sessionId = undefined;

    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'New turn after resume failure');

    // By the time ClaudeSession.run is invoked (synchronously reached before
    // any await inside the mock), the stale board must already be cleared —
    // otherwise the new session's TaskCreate #1/#2 would collide with it.
    expect(thread.tasks).toBeUndefined();
    expect(thread.pendingBackgroundTasks).toBeUndefined();

    const tasksUpdatedEvents = events.filter(e => e.type === 'tasks_updated');
    expect(tasksUpdatedEvents.length).toBeGreaterThan(0);
    expect((tasksUpdatedEvents[0] as { tasks: unknown[] }).tasks).toEqual([]);

    await driveResponse('Done');
    await sendPromise;

    // The new session's own TaskCreate for id "1" must land cleanly, not
    // merge into (or get overwritten by) the stale leftover.
    mock.callbacks!.onTaskEvent!({ kind: 'create', id: '1', content: 'Fresh task from new session' });
    expect(thread.tasks).toEqual([
      { id: '1', content: 'Fresh task from new session', status: 'pending' },
    ]);
  });

  it('does NOT clear thread.tasks when the session is being resumed normally', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());

    thread.messages.push({
      id: 'm1',
      role: 'user',
      content: 'earlier turn',
      timestamp: Date.now(),
    });
    thread.tasks = [{ id: '1', content: 'In-flight task', status: 'in_progress' }];
    thread.sessionId = 'existing-session-id'; // resumable

    const sendPromise = manager.sendMessage(thread.id, 'Continue');

    expect(thread.tasks).toEqual([{ id: '1', content: 'In-flight task', status: 'in_progress' }]);

    await driveResponse('Done', 'existing-session-id');
    await sendPromise;
  });

  it('does NOT clear thread.tasks on the very first message of a brand-new thread', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', process.cwd());
    thread.tasks = undefined; // nothing to clear, but confirm no crash / no-op path

    const sendPromise = manager.sendMessage(thread.id, 'First message');
    expect(thread.tasks).toBeUndefined();

    await driveResponse('Done');
    await sendPromise;

    mock.callbacks!.onTaskEvent!({ kind: 'create', id: '1', content: 'First task' });
    expect(thread.tasks).toEqual([{ id: '1', content: 'First task', status: 'pending' }]);
  });
});

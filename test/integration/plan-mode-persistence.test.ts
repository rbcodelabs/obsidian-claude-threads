/**
 * Integration tests for plan mode persistence.
 *
 * Exercises the full lifecycle:
 *   onPlanReady → thread.pendingPlan set → events emitted
 *   approve / reject → pendingPlan cleared → original callback called
 *   onDone safety-net → stale pendingPlan wiped
 *   JSON round-trip → pendingPlan survives serialization (reload simulation)
 *   per-thread permissionMode → overrides global setting
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// ─── Shared mock state (mirrors thread-manager-events.test.ts pattern) ────────

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  prompt: null as string | null,
  permissionMode: null as unknown,
  resolve: null as (() => void) | null,
  resumeSessionId: undefined as string | undefined,
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      prompt: string,
      resumeSessionId: string | undefined,
      _cwd: unknown,
      permissionMode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
    ): Promise<void> {
      mock.callbacks = callbacks;
      mock.prompt = prompt;
      mock.permissionMode = permissionMode;
      mock.resumeSessionId = resumeSessionId;
      return new Promise<void>((res) => { mock.resolve = res; });
    }
    close() {}
    async interrupt() {
      mock.callbacks?.onInterrupted(mock.resumeSessionId ?? '');
      mock.resolve?.();
    }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides: Record<string, unknown> = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

async function driveResponse(content: string, sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken(content);
  cb.onMessage(content, []);
  cb.onDone(sessionId, 0.001, 1);
  mock.resolve!();
}

/** Collect events emitted while a thunk runs, then wait for the session. */
async function collectEvents(
  manager: InstanceType<typeof ThreadManager>,
  threadId: string,
  fn: (events: ThreadEvent[]) => Promise<void> | void,
): Promise<ThreadEvent[]> {
  const events: ThreadEvent[] = [];
  const unsub = manager.subscribe((id, e) => { if (id === threadId) events.push(e); });
  try {
    await fn(events);
  } finally {
    unsub();
  }
  return events;
}

beforeEach(() => {
  mock.callbacks = null;
  mock.prompt = null;
  mock.permissionMode = null;
  mock.resolve = null;
  mock.resumeSessionId = undefined;
});

// ─── pendingPlan lifecycle ────────────────────────────────────────────────────

describe('pendingPlan — set and persist', () => {
  it('sets thread.pendingPlan when onPlanReady fires', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Make a plan');
    // Simulate ClaudeSession calling the onPlanReady callback
    mock.callbacks!.onPlanReady!('Step 1\nStep 2', () => {}, () => {});

    expect(thread.pendingPlan).toBe('Step 1\nStep 2');

    await driveResponse('Done');
    await sendPromise;
  });

  it('emits pending_plan_changed with the plan text', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const events = await collectEvents(manager, thread.id, async () => {
      const sendPromise = manager.sendMessage(thread.id, 'Make a plan');
      mock.callbacks!.onPlanReady!('Step 1\nStep 2', () => {}, () => {});
      await driveResponse('Done');
      await sendPromise;
    });

    const planChangedEvents = events.filter(e => e.type === 'pending_plan_changed') as
      Array<{ type: 'pending_plan_changed'; planText: string | undefined }>;
    // At least one 'set' event (plan arrives) plus one 'clear' event (onDone safety-net)
    expect(planChangedEvents.length).toBeGreaterThanOrEqual(1);
    expect(planChangedEvents[0].planText).toBe('Step 1\nStep 2');
  });

  it('plan_ready event carries the wrapped approve/reject callbacks', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let capturedApprove: ((edited?: string) => void) | undefined;
    let capturedReject: (() => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') {
        capturedApprove = e.approve;
        capturedReject = e.reject;
      }
    });

    const sendPromise = manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});

    unsub();
    expect(capturedApprove).toBeTypeOf('function');
    expect(capturedReject).toBeTypeOf('function');

    await driveResponse('Done');
    await sendPromise;
  });

  it('pendingPlan survives JSON serialization (reload simulation)', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('## Plan\n1. Do A\n2. Do B', () => {}, () => {});

    // Simulate what Obsidian's saveData/loadData does: JSON round-trip the thread.
    const serialized = JSON.stringify(thread);
    const restored = JSON.parse(serialized);
    expect(restored.pendingPlan).toBe('## Plan\n1. Do A\n2. Do B');

    await driveResponse('Done');
    await sendPromise;
  });
});

// ─── approve path ─────────────────────────────────────────────────────────────

describe('pendingPlan — approve clears it', () => {
  it('clears thread.pendingPlan when the wrapped approve is called', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let capturedApprove: ((edited?: string) => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedApprove = e.approve;
    });

    const sendPromise = manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});
    unsub();

    expect(thread.pendingPlan).toBe('My plan');
    capturedApprove!();
    expect(thread.pendingPlan).toBeUndefined();

    await driveResponse('Implementing');
    await sendPromise;
  });

  it('emits pending_plan_changed with undefined when approve fires', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let capturedApprove: ((edited?: string) => void) | undefined;
    const planEvents: Array<{ type: 'pending_plan_changed'; planText: string | undefined }> = [];
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedApprove = e.approve;
      if (e.type === 'pending_plan_changed') planEvents.push(e as typeof planEvents[number]);
    });

    const sendPromise = manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});
    capturedApprove!();
    unsub();

    const clearEvent = planEvents.find(e => e.planText === undefined);
    expect(clearEvent).toBeTruthy();

    await driveResponse('Done');
    await sendPromise;
  });

  it('passes edited plan text through to the original approve callback', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let receivedEdited: string | undefined = 'sentinel';
    let capturedApprove: ((edited?: string) => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedApprove = e.approve;
    });

    const sendPromise = manager.sendMessage(thread.id, 'Plan');
    mock.callbacks!.onPlanReady!('Original', (ed) => { receivedEdited = ed; }, () => {});
    unsub();

    capturedApprove!('Edited plan text');
    expect(receivedEdited).toBe('Edited plan text');

    await driveResponse('Done');
    await sendPromise;
  });

  it('passes undefined to original approve callback when no edits', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let receivedEdited: string | undefined = 'sentinel';
    let capturedApprove: ((edited?: string) => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedApprove = e.approve;
    });

    const sendPromise = manager.sendMessage(thread.id, 'Plan');
    mock.callbacks!.onPlanReady!('Original', (ed) => { receivedEdited = ed; }, () => {});
    unsub();

    capturedApprove!(undefined);
    expect(receivedEdited).toBeUndefined();

    await driveResponse('Done');
    await sendPromise;
  });
});

// ─── reject path ──────────────────────────────────────────────────────────────

describe('pendingPlan — reject clears it', () => {
  it('clears thread.pendingPlan when the wrapped reject is called', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let capturedReject: (() => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedReject = e.reject;
    });

    const sendPromise = manager.sendMessage(thread.id, 'Make a plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => {});
    unsub();

    expect(thread.pendingPlan).toBe('My plan');
    capturedReject!();
    expect(thread.pendingPlan).toBeUndefined();

    await driveResponse('Stopping');
    await sendPromise;
  });

  it('calls the original reject callback', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    let rejectCalled = false;
    let capturedReject: (() => void) | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'plan_ready') capturedReject = e.reject;
    });

    const sendPromise = manager.sendMessage(thread.id, 'Plan');
    mock.callbacks!.onPlanReady!('My plan', () => {}, () => { rejectCalled = true; });
    unsub();

    capturedReject!();
    expect(rejectCalled).toBe(true);

    await driveResponse('Done');
    await sendPromise;
  });
});

// ─── onDone safety-net ────────────────────────────────────────────────────────

describe('pendingPlan — onDone safety-net', () => {
  it('clears a stale pendingPlan when the session completes normally', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    // Manually set pendingPlan (simulates a stale value from a prior session)
    thread.pendingPlan = 'Stale plan';

    await driveResponse('Done', 'sess-1');
    await sendPromise;

    expect(thread.pendingPlan).toBeUndefined();
  });

  it('emits pending_plan_changed when safety-net clears the plan', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((id, e) => { if (id === thread.id) events.push(e); });

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    thread.pendingPlan = 'Stale plan';

    await driveResponse('Done');
    await sendPromise;

    const clearEvent = events.find(e =>
      e.type === 'pending_plan_changed' &&
      (e as { type: 'pending_plan_changed'; planText: string | undefined }).planText === undefined,
    );
    expect(clearEvent).toBeTruthy();
  });
});

// ─── per-thread permission mode ───────────────────────────────────────────────

describe('per-thread permissionMode', () => {
  it('uses the global setting when thread has no override', async () => {
    const manager = makeManager({ permissionMode: 'acceptEdits' });
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    expect(mock.permissionMode).toBe('acceptEdits');

    await driveResponse('Done');
    await sendPromise;
  });

  it('uses thread.permissionMode when set, overriding the global setting', async () => {
    const manager = makeManager({ permissionMode: 'acceptEdits' });
    const thread = manager.createThread('T', os.tmpdir());
    thread.permissionMode = 'plan';

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    expect(mock.permissionMode).toBe('plan');

    await driveResponse('Done');
    await sendPromise;
  });

  it('falls back to global when thread.permissionMode is cleared (undefined)', async () => {
    const manager = makeManager({ permissionMode: 'dontAsk' });
    const thread = manager.createThread('T', os.tmpdir());

    // Set then clear
    manager.setThreadPermissionMode(thread.id, 'plan');
    manager.setThreadPermissionMode(thread.id, undefined);

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    expect(mock.permissionMode).toBe('dontAsk');

    await driveResponse('Done');
    await sendPromise;
  });

  it('setThreadPermissionMode stores the override on the thread', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    manager.setThreadPermissionMode(thread.id, 'bypassPermissions');
    expect(thread.permissionMode).toBe('bypassPermissions');
  });

  it('setThreadPermissionMode with undefined deletes the override', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    manager.setThreadPermissionMode(thread.id, 'plan');
    manager.setThreadPermissionMode(thread.id, undefined);
    expect(thread.permissionMode).toBeUndefined();
  });

  it('permissionMode override survives JSON serialization', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    manager.setThreadPermissionMode(thread.id, 'plan');

    const restored = JSON.parse(JSON.stringify(thread));
    expect(restored.permissionMode).toBe('plan');
  });
});

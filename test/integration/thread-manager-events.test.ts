import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// Hoisted mock state — accessible inside vi.mock factory
const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  prompt: null as string | null,
  model: null as string | undefined,
  images: null as import('../../src/types').ImageAttachment[] | undefined,
  resolve: null as (() => void) | null,
  resumeSessionId: undefined as string | undefined,
  runCallCount: 0,
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      prompt: string,
      resumeSessionId: string | undefined,
      _cwd: unknown,
      _mode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
      _dirs?: unknown,
      model?: string,
      images?: import('../../src/types').ImageAttachment[],
    ): Promise<void> {
      mock.callbacks = callbacks;
      mock.prompt = prompt;
      mock.model = model;
      mock.images = images;
      mock.resumeSessionId = resumeSessionId;
      mock.runCallCount += 1;
      return new Promise<void>((res) => { mock.resolve = res; });
    }
    close() {}
    async interrupt() {
      // Mirror real ClaudeSession: fire onInterrupted with the pre-interrupt session ID
      mock.callbacks?.onInterrupted(mock.resumeSessionId ?? '');
      mock.resolve?.();
    }
  },
}));

// Import AFTER vi.mock so the mock is in place
const { ThreadManager } = await import('../../src/ThreadManager');
const { Scheduler } = await import('../../src/Scheduler');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

// Helper: drive a complete successful response through the mock
async function driveResponse(content: string, sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken(content);
  cb.onMessage(content, []);
  cb.onDone(sessionId, 0.001, 1);
  mock.resolve!();
}

beforeEach(() => {
  mock.callbacks = null;
  mock.prompt = null;
  mock.model = null;
  mock.images = null;
  mock.resolve = null;
  mock.resumeSessionId = undefined;
  mock.runCallCount = 0;
});

describe('send message → event flow', () => {
  it('emits user_message_added, streaming_start, token, message, done in order', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hello');
    await driveResponse('Hi there');
    await sendPromise;

    // 'run_state_settled' fires once run() has fully unwound (right after
    // 'done' in the fast path where there's no lingering background task) —
    // see run-state-settled.test.ts for the fix this event exists to support.
    expect(events.map(e => e.type)).toEqual(['user_message_added', 'streaming_start', 'token', 'message', 'done', 'run_state_settled']);
  });

  it('appends user and assistant messages to the thread', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Ping');
    await driveResponse('Pong');
    await sendPromise;

    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]).toMatchObject({ role: 'user', content: 'Ping' });
    expect(thread.messages[1]).toMatchObject({ role: 'assistant', content: 'Pong' });
  });

  it('stores sessionId and cost on done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onToken('Hey');
    mock.callbacks!.onMessage('Hey', []);
    mock.callbacks!.onDone('session-xyz', 0.0042, 1);
    mock.resolve!();
    await sendPromise;

    expect(thread.sessionId).toBe('session-xyz');
    expect(thread.messages[1].cost).toBe(0.0042);
  });

  it('isRunning is true during session, false after done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    expect(manager.isRunning(thread.id)).toBe(true);
    await driveResponse('Done');
    await sendPromise;
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('second sendMessage while running queues and auto-fires after done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const p1 = manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Second'); // queues, returns immediately

    expect(events.find(e => e.type === 'queued')).toBeTruthy();
    expect(manager.getQueuedMessage(thread.id)).toBe('Second');

    // Capture first session's references before driving it
    const firstCallbacks = mock.callbacks!;
    const firstResolve = mock.resolve!;

    // Drive first session to completion
    firstCallbacks.onToken('Reply 1');
    firstCallbacks.onMessage('Reply 1', []);
    firstCallbacks.onDone('sess-1', 0.001, 1);
    firstResolve();

    // Wait for the queued message's session to start (microtasks need to settle)
    await vi.waitFor(() => expect(mock.callbacks).not.toBe(firstCallbacks));

    // Drive second session
    mock.callbacks!.onToken('Reply 2');
    mock.callbacks!.onMessage('Reply 2', []);
    mock.callbacks!.onDone('sess-2', 0.001, 1);
    mock.resolve!();

    await p1;

    expect(thread.messages.filter(m => m.role === 'user')).toHaveLength(2);
    expect(thread.messages[0].content).toBe('First');
    expect(thread.messages[2].content).toBe('Second');
    expect(events.find(e => e.type === 'dequeued')).toBeTruthy();
  });

  it('preserves images when a message is queued and later dequeued', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const attachment = { type: 'base64' as const, mediaType: 'image/png' as const, data: 'abc123', name: 'shot.png' };

    const p1 = manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Second', [attachment]); // queues with image

    // queued event should carry the image
    const queuedEvt = events.find(e => e.type === 'queued');
    expect(queuedEvt).toBeTruthy();
    expect((queuedEvt as Extract<ThreadEvent, { type: 'queued' }>).images).toEqual([attachment]);

    // Drive first session to completion
    const firstCallbacks = mock.callbacks!;
    const firstResolve = mock.resolve!;
    firstCallbacks.onToken('Reply 1');
    firstCallbacks.onMessage('Reply 1', []);
    firstCallbacks.onDone('sess-1', 0.001, 1);
    firstResolve();

    // Wait for second session to start
    await vi.waitFor(() => expect(mock.callbacks).not.toBe(firstCallbacks));

    // The second ClaudeSession.run() call should have received the image
    expect(mock.images).toEqual([attachment]);

    // dequeued event should also carry the image
    const dequeuedEvt = events.find(e => e.type === 'dequeued');
    expect(dequeuedEvt).toBeTruthy();
    expect((dequeuedEvt as Extract<ThreadEvent, { type: 'dequeued' }>).images).toEqual([attachment]);

    // Drive second session to completion
    mock.callbacks!.onToken('Reply 2');
    mock.callbacks!.onMessage('Reply 2', []);
    mock.callbacks!.onDone('sess-2', 0.001, 1);
    mock.resolve!();

    await p1;
  });

  it('emits error event and cleans up session on failure', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onError(new Error('Network failure'));
    mock.resolve!();
    await sendPromise;

    expect(events.find(e => e.type === 'error')).toBeTruthy();
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('throws when thread id does not exist', async () => {
    const manager = makeManager();
    await expect(manager.sendMessage('bad-id', 'Hi')).rejects.toThrow('Thread not found');
  });
});

describe('model escalation', () => {
  it('emits escalated event and uses opus model when keyword present', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, '/opus design the architecture');
    await driveResponse('Here is the design');
    await sendPromise;

    const escalated = events.find(e => e.type === 'escalated') as { type: 'escalated'; model: string } | undefined;
    expect(escalated).toBeTruthy();
    expect(escalated!.model).toBe('opus');
    expect(mock.model).toBe('opus');
  });

  it('strips keyword from prompt sent to Claude', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, '/opus write me a poem');
    await driveResponse('Roses are red');
    await sendPromise;

    expect(mock.prompt).toBe('write me a poem');
  });

  it('preserves original text in the stored user message', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, '/opus write me a poem');
    await driveResponse('Roses are red');
    await sendPromise;

    expect(thread.messages[0].content).toBe('/opus write me a poem');
  });

  it('does not escalate when feature is disabled', async () => {
    const manager = makeManager({ escalationEnabled: false, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, '/opus do something');
    await driveResponse('OK');
    await sendPromise;

    expect(events.find(e => e.type === 'escalated')).toBeUndefined();
    expect(mock.model).toBeUndefined();
  });

  it('does not escalate when keyword not in message', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'just a normal message');
    await driveResponse('Sure');
    await sendPromise;

    expect(events.find(e => e.type === 'escalated')).toBeUndefined();
    expect(mock.model).toBeUndefined();
  });

  it('respects custom escalation keyword', async () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '!expert', escalationModel: 'opus' });
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, '!expert help me');
    await driveResponse('Expert answer');
    await sendPromise;

    expect(events.find(e => e.type === 'escalated')).toBeTruthy();
    expect(mock.prompt).toBe('help me');
  });
});

describe('permission handler', () => {
  it('calls permissionHandler and allows when it resolves true', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    manager.permissionHandler = async () => true;

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    const result = await mock.callbacks!.onPermissionRequest('Write', '/some/file.ts');
    await driveResponse('Done');
    await sendPromise;

    expect(result).toBe(true);
  });

  it('calls permissionHandler and denies when it resolves false', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    manager.permissionHandler = async () => false;

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    const result = await mock.callbacks!.onPermissionRequest('Bash', 'rm -rf /');
    await driveResponse('Done');
    await sendPromise;

    expect(result).toBe(false);
  });
});

describe('tool use events', () => {
  it('emits tool_use event and stores tool calls on message', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Do something');
    const toolRecord = { name: 'Write', summary: 'Write: src/foo.ts' };
    mock.callbacks!.onToolUse(toolRecord);
    mock.callbacks!.onMessage('Done', [toolRecord]);
    mock.callbacks!.onDone('s1', 0, 1);
    mock.resolve!();
    await sendPromise;

    const toolEvent = events.find(e => e.type === 'tool_use') as { type: 'tool_use'; record: typeof toolRecord } | undefined;
    expect(toolEvent?.record.name).toBe('Write');
    const assistantMsg = thread.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.toolCalls?.[0].name).toBe('Write');
  });
});

describe('recap events', () => {
  it('stores recap on thread and emits recap event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onRecap('Used Write (2 calls)');
    await driveResponse('Done');
    await sendPromise;

    expect(thread.recap).toBe('Used Write (2 calls)');
    expect(events.find(e => e.type === 'recap')).toBeTruthy();
  });
});

describe('image attachments', () => {
  it('passes images to session.run', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const images: import('../../src/types').ImageAttachment[] = [
      { base64: 'abc123', mediaType: 'image/png', name: 'screenshot.png' },
    ];

    const sendPromise = manager.sendMessage(thread.id, 'Look at this', images);
    await driveResponse('I see it');
    await sendPromise;

    expect(mock.images).toEqual(images);
    expect(mock.prompt).toBe('Look at this');
  });

  it('passes undefined images when none provided', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'No images here');
    await driveResponse('OK');
    await sendPromise;

    expect(mock.images).toBeUndefined();
  });

  it('stores user message content as the text prompt regardless of images', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const images: import('../../src/types').ImageAttachment[] = [
      { base64: 'xyz', mediaType: 'image/jpeg', name: 'photo.jpg' },
    ];

    const sendPromise = manager.sendMessage(thread.id, 'Describe this', images);
    await driveResponse('Sure');
    await sendPromise;

    expect(thread.messages[0]).toMatchObject({ role: 'user', content: 'Describe this' });
  });
});

describe('system events', () => {
  it('emits status event when onStatus is called', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onStatus!('compacting');
    await driveResponse('Done');
    await sendPromise;

    const statusEvent = events.find(e => e.type === 'status') as { type: 'status'; status: string } | undefined;
    expect(statusEvent?.status).toBe('compacting');
  });

  it('emits status null to clear compacting', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onStatus!(null);
    await driveResponse('Done');
    await sendPromise;

    const statusEvent = events.find(e => e.type === 'status') as { type: 'status'; status: null } | undefined;
    expect(statusEvent?.status).toBeNull();
  });

  it('emits task_started event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskStarted!('task-1', 'Running security audit', false);
    await driveResponse('Done');
    await sendPromise;

    const taskEvent = events.find(e => e.type === 'task_started') as
      { type: 'task_started'; taskId: string; description: string; skipTranscript: boolean } | undefined;
    expect(taskEvent?.taskId).toBe('task-1');
    expect(taskEvent?.description).toBe('Running security audit');
    expect(taskEvent?.skipTranscript).toBe(false);
  });

  it('emits task_progress event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskProgress!('task-1', 'Scanning files', 'Grep');
    await driveResponse('Done');
    await sendPromise;

    const evt = events.find(e => e.type === 'task_progress') as
      { type: 'task_progress'; taskId: string; description: string; lastToolName?: string } | undefined;
    expect(evt?.taskId).toBe('task-1');
    expect(evt?.lastToolName).toBe('Grep');
  });

  it('emits task_notification on completion', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskNotification!('task-1', 'completed', 'Found 3 issues');
    await driveResponse('Done');
    await sendPromise;

    const evt = events.find(e => e.type === 'task_notification') as
      { type: 'task_notification'; taskId: string; status: string; summary: string } | undefined;
    expect(evt?.status).toBe('completed');
    expect(evt?.summary).toBe('Found 3 issues');
  });

  it('emits task_notification on failure', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onTaskNotification!('task-1', 'failed', 'Timed out');
    await driveResponse('Done');
    await sendPromise;

    const evt = events.find(e => e.type === 'task_notification') as
      { type: 'task_notification'; status: string } | undefined;
    expect(evt?.status).toBe('failed');
  });

  it('emits notification event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onNotification!('Deploy succeeded', 'high');
    await driveResponse('Done');
    await sendPromise;

    const evt = events.find(e => e.type === 'notification') as
      { type: 'notification'; text: string; priority: string } | undefined;
    expect(evt?.text).toBe('Deploy succeeded');
    expect(evt?.priority).toBe('high');
  });

  it('emits api_retry event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onApiRetry!(1, 3, 'server_error');
    await driveResponse('Done');
    await sendPromise;

    const evt = events.find(e => e.type === 'api_retry') as
      { type: 'api_retry'; attempt: number; maxRetries: number; error: string } | undefined;
    expect(evt?.attempt).toBe(1);
    expect(evt?.maxRetries).toBe(3);
    expect(evt?.error).toBe('server_error');
  });

  it('emits rate_limit event for rejected status', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onRateLimit!('rejected', 1700000000000);
    await driveResponse('Done');
    await sendPromise;

    const evt = events.find(e => e.type === 'rate_limit') as
      { type: 'rate_limit'; limitStatus: string; resetsAt?: number } | undefined;
    expect(evt?.limitStatus).toBe('rejected');
    expect(evt?.resetsAt).toBe(1700000000000);
  });

  it('emits rate_limit event for warning status without resetsAt', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    mock.callbacks!.onRateLimit!('allowed_warning', undefined);
    await driveResponse('Done');
    await sendPromise;

    const evt = events.find(e => e.type === 'rate_limit') as
      { type: 'rate_limit'; limitStatus: string; resetsAt?: number } | undefined;
    expect(evt?.limitStatus).toBe('allowed_warning');
    expect(evt?.resetsAt).toBeUndefined();
  });
});

describe('interrupt / stop behavior', () => {
  it('emits interrupted event (not done) when stop is hit', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hello');
    await manager.interrupt(thread.id);
    await sendPromise;

    const types = events.map(e => e.type);
    expect(types).toContain('interrupted');
    expect(types).not.toContain('done');
  });

  it('rolls back the orphaned user message from thread.messages', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Hello');
    // Message is in the array while running
    expect(thread.messages).toHaveLength(1);
    await manager.interrupt(thread.id);
    await sendPromise;

    // After interrupt it should be removed
    expect(thread.messages).toHaveLength(0);
  });

  it('preserves the prior session ID — does not corrupt it', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    thread.sessionId = 'prior-session-id';

    const sendPromise = manager.sendMessage(thread.id, 'Hello');
    await manager.interrupt(thread.id);
    await sendPromise;

    expect(thread.sessionId).toBe('prior-session-id');
  });

  it('isRunning is false after interrupt', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Hello');
    expect(manager.isRunning(thread.id)).toBe(true);
    await manager.interrupt(thread.id);
    await sendPromise;
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('preserves all prior messages from successful turns — only interrupted turn is rolled back', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    // First turn completes successfully
    const p1 = manager.sendMessage(thread.id, 'First');
    await driveResponse('First response', 'sess-1');
    await p1;

    expect(thread.messages).toHaveLength(2);

    // Second message gets interrupted before any response
    const p2 = manager.sendMessage(thread.id, 'Second');
    await manager.interrupt(thread.id);
    await p2;

    // Only the first turn's messages remain; session ID is still the successful one
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]).toMatchObject({ role: 'user', content: 'First' });
    expect(thread.messages[1]).toMatchObject({ role: 'assistant', content: 'First response' });
    expect(thread.sessionId).toBe('sess-1');
  });

  it('resumes from the correct session ID on the next send after interrupt', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    // First turn establishes a session
    const p1 = manager.sendMessage(thread.id, 'First');
    await driveResponse('First response', 'sess-1');
    await p1;

    // Second turn interrupted
    const p2 = manager.sendMessage(thread.id, 'Interrupted');
    await manager.interrupt(thread.id);
    await p2;

    // Third turn — should resume from sess-1, not from an empty/corrupted ID
    const p3 = manager.sendMessage(thread.id, 'Third');
    await driveResponse('Third response', 'sess-2');
    await p3;

    expect(mock.resumeSessionId).toBe('sess-1');
    expect(thread.messages).toHaveLength(4);
  });

  it('discards any queued message when interrupted', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const p1 = manager.sendMessage(thread.id, 'First');
    await manager.sendMessage(thread.id, 'Queued'); // parks in queue

    expect(manager.getQueuedMessage(thread.id)).toBe('Queued');

    await manager.interrupt(thread.id);
    await p1;

    // Queue cleared, dequeued never fired
    expect(manager.getQueuedMessage(thread.id)).toBeUndefined();
    expect(events.find(e => e.type === 'dequeued')).toBeUndefined();
  });
});

describe('Scheduler + ThreadManager: busy-thread dedup on loop tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as Record<string, unknown>).window = globalThis;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).window;
  });

  it('defers a loop tick that arrives while the kickoff turn is still running', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const scheduler = new Scheduler({
      getItems: () => [],
      saveItem: async () => {},
      removeItem: async () => {},
      createThread: () => ({ id: 'unused' }),
      sendMessage: (id, prompt) => manager.sendMessage(id, prompt),
      getDefaultCwd: () => os.tmpdir(),
      threadExists: (id) => id === thread.id,
      isThreadBusy: (id) => manager.isRunning(id),
    });
    scheduler.start([]);

    // Simulate Fix 1's immediate kickoff: a message is sent right away and is
    // still in flight (ClaudeSession.run has not resolved).
    const kickoff = manager.sendMessage(thread.id, 'kickoff prompt');
    expect(manager.isRunning(thread.id)).toBe(true);
    expect(mock.runCallCount).toBe(1);

    scheduler.createItem({
      name: 'Loop: recurring',
      prompt: 'loop prompt',
      schedule: { type: 'interval', intervalSeconds: 10 },
      enabled: true,
      targetThreadId: thread.id,
    });

    // The interval elapses while the kickoff turn is still running. The tick
    // must be deferred (retried) rather than firing a second sendMessage
    // that would queue as a duplicate turn.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mock.runCallCount).toBe(1);
    expect(manager.getQueuedMessage(thread.id)).toBeUndefined();

    // Finish the kickoff turn — the thread becomes free.
    const cb = mock.callbacks!;
    cb.onToken('kickoff done');
    cb.onMessage('kickoff done', []);
    cb.onDone('sess-1', 0.001, 1);
    mock.resolve!();
    await kickoff;
    expect(manager.isRunning(thread.id)).toBe(false);

    // The scheduler's retry (capped at 15s) should now find the thread free
    // and send the loop prompt exactly once.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mock.runCallCount).toBe(2);
    expect(mock.prompt).toBe('loop prompt');
    expect(manager.getQueuedMessage(thread.id)).toBeUndefined();

    // Clean up the still-running loop turn so the test doesn't leak a
    // dangling promise.
    await manager.interrupt(thread.id);
    scheduler.destroy();
  });
});

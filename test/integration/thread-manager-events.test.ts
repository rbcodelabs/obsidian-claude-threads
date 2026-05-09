import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// Hoisted mock state — accessible inside vi.mock factory
const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  prompt: null as string | null,
  model: null as string | undefined,
  resolve: null as (() => void) | null,
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      prompt: string,
      _sid: unknown,
      _cwd: unknown,
      _mode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
      _dirs?: unknown,
      model?: string,
    ): Promise<void> {
      mock.callbacks = callbacks;
      mock.prompt = prompt;
      mock.model = model;
      return new Promise<void>((res) => { mock.resolve = res; });
    }
    close() {}
    async interrupt() { mock.resolve?.(); }
  },
}));

// Import AFTER vi.mock so the mock is in place
const { ThreadManager } = await import('../../src/ThreadManager');

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
  mock.resolve = null;
});

describe('send message → event flow', () => {
  it('emits streaming_start, token, message, done in order', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'Hello');
    await driveResponse('Hi there');
    await sendPromise;

    expect(events.map(e => e.type)).toEqual(['streaming_start', 'token', 'message', 'done']);
  });

  it('appends user and assistant messages to the thread', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Ping');
    await driveResponse('Pong');
    await sendPromise;

    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]).toMatchObject({ role: 'user', content: 'Ping' });
    expect(thread.messages[1]).toMatchObject({ role: 'assistant', content: 'Pong' });
  });

  it('stores sessionId and cost on done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');

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
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    expect(manager.isRunning(thread.id)).toBe(true);
    await driveResponse('Done');
    await sendPromise;
    expect(manager.isRunning(thread.id)).toBe(false);
  });

  it('second sendMessage while running queues and auto-fires after done', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
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

  it('emits error event and cleans up session on failure', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
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

describe('opus escalation', () => {
  it('emits escalated event and uses opus model when keyword present', async () => {
    const manager = makeManager({ opusEscalationEnabled: true, opusEscalationKeyword: '/opus' });
    const thread = manager.createThread('T', '/cwd');
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
    const manager = makeManager({ opusEscalationEnabled: true, opusEscalationKeyword: '/opus' });
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, '/opus write me a poem');
    await driveResponse('Roses are red');
    await sendPromise;

    expect(mock.prompt).toBe('write me a poem');
  });

  it('preserves original text in the stored user message', async () => {
    const manager = makeManager({ opusEscalationEnabled: true, opusEscalationKeyword: '/opus' });
    const thread = manager.createThread('T', '/cwd');

    const sendPromise = manager.sendMessage(thread.id, '/opus write me a poem');
    await driveResponse('Roses are red');
    await sendPromise;

    expect(thread.messages[0].content).toBe('/opus write me a poem');
  });

  it('does not escalate when feature is disabled', async () => {
    const manager = makeManager({ opusEscalationEnabled: false, opusEscalationKeyword: '/opus' });
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, '/opus do something');
    await driveResponse('OK');
    await sendPromise;

    expect(events.find(e => e.type === 'escalated')).toBeUndefined();
    expect(mock.model).toBeUndefined();
  });

  it('does not escalate when keyword not in message', async () => {
    const manager = makeManager({ opusEscalationEnabled: true, opusEscalationKeyword: '/opus' });
    const thread = manager.createThread('T', '/cwd');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendPromise = manager.sendMessage(thread.id, 'just a normal message');
    await driveResponse('Sure');
    await sendPromise;

    expect(events.find(e => e.type === 'escalated')).toBeUndefined();
    expect(mock.model).toBeUndefined();
  });

  it('respects custom escalation keyword', async () => {
    const manager = makeManager({ opusEscalationEnabled: true, opusEscalationKeyword: '!expert' });
    const thread = manager.createThread('T', '/cwd');
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
    const thread = manager.createThread('T', '/cwd');
    manager.permissionHandler = async () => true;

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    const result = await mock.callbacks!.onPermissionRequest('Write', '/some/file.ts');
    await driveResponse('Done');
    await sendPromise;

    expect(result).toBe(true);
  });

  it('calls permissionHandler and denies when it resolves false', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', '/cwd');
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
    const thread = manager.createThread('T', '/cwd');
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
    const thread = manager.createThread('T', '/cwd');
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

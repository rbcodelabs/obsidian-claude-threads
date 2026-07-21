/**
 * Tests for MobileThreadStore.
 *
 * Covers: snapshot hydration, token accumulation, thread CRUD events,
 * and permission request lifecycle.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MobileThreadStore } from '../../src/MobileThreadStore';
import type { SerializedThread, SerializedMessage, RelayFrame } from '../../src/relay-protocol';

function makeThread(overrides: Partial<SerializedThread> = {}): SerializedThread {
  return {
    id: 'thread-1',
    title: 'Thread 1',
    cwd: '/cwd',
    messages: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Hello',
    timestamp: 1000,
    ...overrides,
  };
}

describe('MobileThreadStore — snapshot hydration', () => {
  let store: MobileThreadStore;

  beforeEach(() => {
    store = new MobileThreadStore();
  });

  it('hydrates threads from snapshot', () => {
    const t1 = makeThread({ id: 'a', title: 'Alpha' });
    const t2 = makeThread({ id: 'b', title: 'Beta', createdAt: 2000 });
    store.applyFrame({ type: 'snapshot', threads: [t1, t2], activeThreadId: 'a' });

    expect(store.getThreads()).toHaveLength(2);
    expect(store.getThread('a')?.title).toBe('Alpha');
    expect(store.getActiveThreadId()).toBe('a');
  });

  it('clears previous state on snapshot', () => {
    store.applyFrame({ type: 'snapshot', threads: [makeThread()], activeThreadId: 'thread-1' });
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    expect(store.getThreads()).toHaveLength(0);
    expect(store.getActiveThreadId()).toBeNull();
  });

  it('falls back to last thread if activeThreadId is missing from snapshot', () => {
    const t1 = makeThread({ id: 'a', createdAt: 1000 });
    const t2 = makeThread({ id: 'b', createdAt: 2000 });
    store.applyFrame({ type: 'snapshot', threads: [t1, t2], activeThreadId: 'nonexistent' });

    // Should pick one of the threads — the last by createdAt
    expect(store.getActiveThreadId()).toBe('b');
  });

  it('sorts threads by createdAt', () => {
    const t1 = makeThread({ id: 'a', createdAt: 3000 });
    const t2 = makeThread({ id: 'b', createdAt: 1000 });
    const t3 = makeThread({ id: 'c', createdAt: 2000 });
    store.applyFrame({ type: 'snapshot', threads: [t1, t2, t3], activeThreadId: null });

    const ids = store.getThreads().map(t => t.id);
    expect(ids).toEqual(['b', 'c', 'a']);
  });
});

describe('MobileThreadStore — streaming / token accumulation', () => {
  let store: MobileThreadStore;

  beforeEach(() => {
    store = new MobileThreadStore();
    store.applyFrame({ type: 'snapshot', threads: [makeThread()], activeThreadId: 'thread-1' });
  });

  it('starts streaming on streaming_start', () => {
    store.applyFrame({ type: 'streaming_start', threadId: 'thread-1' });
    expect(store.isStreaming('thread-1')).toBe(true);
    expect(store.getStreamingContent('thread-1')).toBe('');
  });

  it('accumulates tokens', () => {
    store.applyFrame({ type: 'streaming_start', threadId: 'thread-1' });
    store.applyFrame({ type: 'token', threadId: 'thread-1', text: 'Hello ' });
    store.applyFrame({ type: 'token', threadId: 'thread-1', text: 'world' });

    expect(store.getStreamingContent('thread-1')).toBe('Hello world');
  });

  it('clears streaming on done', () => {
    store.applyFrame({ type: 'streaming_start', threadId: 'thread-1' });
    store.applyFrame({ type: 'token', threadId: 'thread-1', text: 'Hi' });
    store.applyFrame({ type: 'done', threadId: 'thread-1' });

    expect(store.isStreaming('thread-1')).toBe(false);
    expect(store.getStreamingContent('thread-1')).toBe('');
  });

  it('clears streaming on message and appends message to thread', () => {
    store.applyFrame({ type: 'streaming_start', threadId: 'thread-1' });
    store.applyFrame({ type: 'token', threadId: 'thread-1', text: 'Hello' });

    const msg = makeMessage({ id: 'm2', content: 'Hello' });
    store.applyFrame({ type: 'message', threadId: 'thread-1', message: msg });

    expect(store.isStreaming('thread-1')).toBe(false);
    const thread = store.getThread('thread-1');
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0].id).toBe('m2');
  });

  it('clears streaming on error and updates lastError', () => {
    store.applyFrame({ type: 'streaming_start', threadId: 'thread-1' });
    store.applyFrame({ type: 'error', threadId: 'thread-1', error: 'Network error' });

    expect(store.isStreaming('thread-1')).toBe(false);
    expect(store.getThread('thread-1')?.lastError).toBe('Network error');
  });
});

describe('MobileThreadStore — thread CRUD events', () => {
  let store: MobileThreadStore;

  beforeEach(() => {
    store = new MobileThreadStore();
    store.applyFrame({ type: 'snapshot', threads: [makeThread()], activeThreadId: 'thread-1' });
  });

  it('thread_created adds the thread', () => {
    const t2 = makeThread({ id: 'thread-2', title: 'Two' });
    store.applyFrame({ type: 'thread_created', thread: t2 });

    expect(store.getThread('thread-2')?.title).toBe('Two');
    expect(store.getThreads()).toHaveLength(2);
  });

  it('thread_deleted removes the thread', () => {
    store.applyFrame({ type: 'thread_deleted', threadId: 'thread-1' });

    expect(store.getThread('thread-1')).toBeUndefined();
    expect(store.getThreads()).toHaveLength(0);
  });

  it('thread_deleted switches active thread when the active one is deleted', () => {
    const t2 = makeThread({ id: 'thread-2', createdAt: 9999 });
    store.applyFrame({ type: 'thread_created', thread: t2 });
    store.applyFrame({ type: 'thread_deleted', threadId: 'thread-1' });

    expect(store.getActiveThreadId()).toBe('thread-2');
  });

  it('thread_renamed updates title', () => {
    store.applyFrame({ type: 'thread_renamed', threadId: 'thread-1', title: 'Renamed' });

    expect(store.getThread('thread-1')?.title).toBe('Renamed');
  });

  it('thread_renamed is a no-op for unknown threadId', () => {
    // Should not throw
    store.applyFrame({ type: 'thread_renamed', threadId: 'nonexistent', title: 'Ignored' });
    expect(store.getThreads()).toHaveLength(1);
  });

  it('thread_renamed notifies subscribers', () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyFrame({ type: 'thread_renamed', threadId: 'thread-1', title: 'Alert' });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('MobileThreadStore — permission request lifecycle', () => {
  let store: MobileThreadStore;

  beforeEach(() => {
    store = new MobileThreadStore();
    store.applyFrame({ type: 'snapshot', threads: [makeThread()], activeThreadId: 'thread-1' });
  });

  it('adds a pending permission on permission_request', () => {
    store.applyFrame({
      type: 'permission_request',
      threadId: 'thread-1',
      toolName: 'Bash',
      detail: 'rm -rf /tmp',
      requestId: 'req-1',
    });

    const perms = store.getPendingPermissionsForThread('thread-1');
    expect(perms).toHaveLength(1);
    expect(perms[0].toolName).toBe('Bash');
    expect(perms[0].requestId).toBe('req-1');
  });

  it('removes permission by requestId on permission_resolved', () => {
    store.applyFrame({
      type: 'permission_request',
      threadId: 'thread-1',
      toolName: 'Bash',
      detail: 'rm -rf /tmp',
      requestId: 'req-1',
    });
    store.applyFrame({ type: 'permission_resolved', threadId: 'thread-1', requestId: 'req-1' });

    expect(store.getPendingPermissionsForThread('thread-1')).toHaveLength(0);
  });

  it('removes first permission by threadId when requestId is empty', () => {
    store.applyFrame({
      type: 'permission_request',
      threadId: 'thread-1',
      toolName: 'Bash',
      detail: '',
      requestId: 'req-1',
    });
    // Simulate legacy path where requestId is empty in resolved frame
    store.applyFrame({ type: 'permission_resolved', threadId: 'thread-1', requestId: '' });

    expect(store.getPendingPermissionsForThread('thread-1')).toHaveLength(0);
  });

  it('can handle multiple simultaneous permissions for different threads', () => {
    const t2 = makeThread({ id: 'thread-2' });
    store.applyFrame({ type: 'thread_created', thread: t2 });

    store.applyFrame({
      type: 'permission_request',
      threadId: 'thread-1',
      toolName: 'Bash',
      detail: 'A',
      requestId: 'req-a',
    });
    store.applyFrame({
      type: 'permission_request',
      threadId: 'thread-2',
      toolName: 'Write',
      detail: 'B',
      requestId: 'req-b',
    });

    expect(store.getPendingPermissions()).toHaveLength(2);
    expect(store.getPendingPermissionsForThread('thread-1')).toHaveLength(1);
    expect(store.getPendingPermissionsForThread('thread-2')).toHaveLength(1);
  });

  it('clears permissions for deleted thread', () => {
    store.applyFrame({
      type: 'permission_request',
      threadId: 'thread-1',
      toolName: 'Bash',
      detail: '',
      requestId: 'req-1',
    });
    store.applyFrame({ type: 'thread_deleted', threadId: 'thread-1' });

    expect(store.getPendingPermissions()).toHaveLength(0);
  });
});

describe('MobileThreadStore — question request lifecycle', () => {
  let store: MobileThreadStore;

  beforeEach(() => {
    store = new MobileThreadStore();
    store.applyFrame({ type: 'snapshot', threads: [makeThread()], activeThreadId: 'thread-1' });
  });

  const sampleQuestions = [
    {
      header: 'Header',
      question: 'Which option?',
      multiSelect: false,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    },
  ];

  it('adds a pending question on question_request', () => {
    store.applyFrame({
      type: 'question_request',
      threadId: 'thread-1',
      questions: sampleQuestions,
      requestId: 'req-1',
    });

    const questions = store.getPendingQuestionsForThread('thread-1');
    expect(questions).toHaveLength(1);
    expect(questions[0].questions).toEqual(sampleQuestions);
    expect(questions[0].requestId).toBe('req-1');
  });

  it('removes question by requestId on question_resolved', () => {
    store.applyFrame({
      type: 'question_request',
      threadId: 'thread-1',
      questions: sampleQuestions,
      requestId: 'req-1',
    });
    store.applyFrame({ type: 'question_resolved', threadId: 'thread-1', requestId: 'req-1' });

    expect(store.getPendingQuestionsForThread('thread-1')).toHaveLength(0);
  });

  it('removes first question by threadId when requestId is empty', () => {
    store.applyFrame({
      type: 'question_request',
      threadId: 'thread-1',
      questions: sampleQuestions,
      requestId: 'req-1',
    });
    // Simulate legacy path where requestId is empty in resolved frame
    store.applyFrame({ type: 'question_resolved', threadId: 'thread-1', requestId: '' });

    expect(store.getPendingQuestionsForThread('thread-1')).toHaveLength(0);
  });

  it('can handle multiple simultaneous questions for different threads', () => {
    const t2 = makeThread({ id: 'thread-2' });
    store.applyFrame({ type: 'thread_created', thread: t2 });

    store.applyFrame({
      type: 'question_request',
      threadId: 'thread-1',
      questions: sampleQuestions,
      requestId: 'req-a',
    });
    store.applyFrame({
      type: 'question_request',
      threadId: 'thread-2',
      questions: sampleQuestions,
      requestId: 'req-b',
    });

    expect(store.getPendingQuestions()).toHaveLength(2);
    expect(store.getPendingQuestionsForThread('thread-1')).toHaveLength(1);
    expect(store.getPendingQuestionsForThread('thread-2')).toHaveLength(1);
  });

  it('clears questions for deleted thread', () => {
    store.applyFrame({
      type: 'question_request',
      threadId: 'thread-1',
      questions: sampleQuestions,
      requestId: 'req-1',
    });
    store.applyFrame({ type: 'thread_deleted', threadId: 'thread-1' });

    expect(store.getPendingQuestions()).toHaveLength(0);
  });
});

describe('MobileThreadStore — desktop_reconnected', () => {
  it('clears all state on desktop_reconnected', () => {
    const store = new MobileThreadStore();
    store.applyFrame({ type: 'snapshot', threads: [makeThread()], activeThreadId: 'thread-1' });
    store.applyFrame({ type: 'streaming_start', threadId: 'thread-1' });
    store.applyFrame({
      type: 'permission_request',
      threadId: 'thread-1',
      toolName: 'Bash',
      detail: '',
      requestId: 'req-1',
    });
    store.applyFrame({
      type: 'question_request',
      threadId: 'thread-1',
      questions: [{ header: '', question: 'Q?', multiSelect: false, options: [] }],
      requestId: 'q-req-1',
    });

    store.applyFrame({ type: 'desktop_reconnected' });

    expect(store.getThreads()).toHaveLength(0);
    expect(store.getActiveThreadId()).toBeNull();
    expect(store.getPendingPermissions()).toHaveLength(0);
    expect(store.getPendingQuestions()).toHaveLength(0);
    expect(store.isStreaming('thread-1')).toBe(false);
  });
});

describe('MobileThreadStore — subscribe', () => {
  it('notifies listeners on every frame', () => {
    const store = new MobileThreadStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });
    expect(listener).toHaveBeenCalledOnce();

    store.applyFrame({ type: 'snapshot', threads: [makeThread()], activeThreadId: 'thread-1' });
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    store.applyFrame({ type: 'done', threadId: 'thread-1' });
    expect(listener).toHaveBeenCalledTimes(2); // No more calls after unsub
  });

  it('setActiveThreadId triggers notification and updates state', () => {
    const store = new MobileThreadStore();
    const t1 = makeThread({ id: 'a' });
    const t2 = makeThread({ id: 'b' });
    store.applyFrame({ type: 'snapshot', threads: [t1, t2], activeThreadId: 'a' });

    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveThreadId('b');

    expect(listener).toHaveBeenCalledOnce();
    expect(store.getActiveThreadId()).toBe('b');
  });

  it('setActiveThreadId ignores unknown thread IDs', () => {
    const store = new MobileThreadStore();
    store.applyFrame({ type: 'snapshot', threads: [makeThread()], activeThreadId: 'thread-1' });

    store.setActiveThreadId('nonexistent');
    expect(store.getActiveThreadId()).toBe('thread-1'); // unchanged
  });
});

/**
 * Integration tests for AskUserQuestion persistence — the inline question
 * card's plumbing counterpart to plan-mode-persistence.test.ts.
 *
 * Exercises the full lifecycle:
 *   onAskUserQuestion → thread.pendingQuestions set → events emitted
 *   registerQuestionResolver / resolveQuestion → pendingQuestions cleared → answers returned to the session
 *   onDone safety-net → stale pendingQuestions wiped
 *   JSON round-trip → pendingQuestions survives serialization (reload simulation)
 *   hasPendingQuestion / getPendingQuestionResolver reflect live state
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { AskQuestion } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// ─── Shared mock state (mirrors plan-mode-persistence.test.ts pattern) ────────

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  prompt: null as string | null,
  resolve: null as (() => void) | null,
  resumeSessionId: undefined as string | undefined,
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      prompt: string,
      resumeSessionId: string | undefined,
      _cwd: unknown,
      _permissionMode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
    ): Promise<void> {
      mock.callbacks = callbacks;
      mock.prompt = prompt;
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

/** Wires questionHandler the same way ThreadsView does: register a resolver and
 * let the test drive resolution via manager.resolveQuestion(). */
function wireQuestionHandler(manager: InstanceType<typeof ThreadManager>) {
  manager.questionHandler = (threadId, _questions) =>
    new Promise((resolve) => {
      manager.registerQuestionResolver(threadId, resolve);
    });
}

async function driveResponse(content: string, sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken(content);
  cb.onMessage(content, []);
  cb.onDone(sessionId, 0.001, 1);
  mock.resolve!();
}

/** Collect events emitted while a thunk runs. */
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

const SAMPLE_QUESTIONS: AskQuestion[] = [
  {
    question: 'Which color?',
    header: 'Color',
    options: [
      { label: 'Red', description: '' },
      { label: 'Blue', description: '' },
    ],
    multiSelect: false,
  },
];

beforeEach(() => {
  mock.callbacks = null;
  mock.prompt = null;
  mock.resolve = null;
  mock.resumeSessionId = undefined;
});

// ─── pendingQuestions lifecycle ───────────────────────────────────────────────

describe('pendingQuestions — set and persist', () => {
  it('sets thread.pendingQuestions when onAskUserQuestion fires', async () => {
    const manager = makeManager();
    wireQuestionHandler(manager);
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Ask me something');
    void mock.callbacks!.onAskUserQuestion(SAMPLE_QUESTIONS);

    expect(thread.pendingQuestions).toEqual(SAMPLE_QUESTIONS);

    manager.resolveQuestion(thread.id, { 'Which color?': 'Red' });
    await driveResponse('Done');
    await sendPromise;
  });

  it('emits pending_question_changed with the question set', async () => {
    const manager = makeManager();
    wireQuestionHandler(manager);
    const thread = manager.createThread('T', os.tmpdir());

    const events = await collectEvents(manager, thread.id, async () => {
      const sendPromise = manager.sendMessage(thread.id, 'Ask me something');
      void mock.callbacks!.onAskUserQuestion(SAMPLE_QUESTIONS);
      manager.resolveQuestion(thread.id, { 'Which color?': 'Red' });
      await driveResponse('Done');
      await sendPromise;
    });

    const changedEvents = events.filter(e => e.type === 'pending_question_changed') as
      Array<{ type: 'pending_question_changed'; questions: AskQuestion[] | undefined }>;
    // One 'set' event (question arrives) plus one 'clear' event (answered)
    expect(changedEvents.length).toBeGreaterThanOrEqual(2);
    expect(changedEvents[0].questions).toEqual(SAMPLE_QUESTIONS);
    expect(changedEvents[changedEvents.length - 1].questions).toBeUndefined();
  });

  it('question_ready event carries the questions', async () => {
    const manager = makeManager();
    wireQuestionHandler(manager);
    const thread = manager.createThread('T', os.tmpdir());

    let captured: AskQuestion[] | undefined;
    const unsub = manager.subscribe((_, e) => {
      if (e.type === 'question_ready') captured = e.questions;
    });

    const sendPromise = manager.sendMessage(thread.id, 'Ask me something');
    void mock.callbacks!.onAskUserQuestion(SAMPLE_QUESTIONS);

    unsub();
    expect(captured).toEqual(SAMPLE_QUESTIONS);

    manager.resolveQuestion(thread.id, { 'Which color?': 'Red' });
    await driveResponse('Done');
    await sendPromise;
  });

  it('pendingQuestions survives JSON serialization (reload simulation)', async () => {
    const manager = makeManager();
    wireQuestionHandler(manager);
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Ask me something');
    void mock.callbacks!.onAskUserQuestion(SAMPLE_QUESTIONS);

    const serialized = JSON.stringify(thread);
    const restored = JSON.parse(serialized);
    expect(restored.pendingQuestions).toEqual(SAMPLE_QUESTIONS);

    manager.resolveQuestion(thread.id, { 'Which color?': 'Red' });
    await driveResponse('Done');
    await sendPromise;
  });
});

// ─── resolve path ─────────────────────────────────────────────────────────────

describe('pendingQuestions — resolveQuestion clears it and returns answers', () => {
  it('clears thread.pendingQuestions and pendingQuestionResolvers when resolved', async () => {
    const manager = makeManager();
    wireQuestionHandler(manager);
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Ask me something');
    void mock.callbacks!.onAskUserQuestion(SAMPLE_QUESTIONS);

    expect(thread.pendingQuestions).toEqual(SAMPLE_QUESTIONS);
    expect(manager.hasPendingQuestion(thread.id)).toBe(true);

    manager.resolveQuestion(thread.id, { 'Which color?': 'Red' });
    // resolveQuestion synchronously invokes the resolver, but the promise chain's
    // `finally` clears state on a microtask — flush it.
    await Promise.resolve();
    await Promise.resolve();

    expect(thread.pendingQuestions).toBeUndefined();
    expect(manager.hasPendingQuestion(thread.id)).toBe(false);
    expect(manager.getPendingQuestionResolver(thread.id)).toBeUndefined();

    await driveResponse('Done');
    await sendPromise;
  });

  it('returns the answers to the awaiting onAskUserQuestion caller', async () => {
    const manager = makeManager();
    wireQuestionHandler(manager);
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Ask me something');
    const answerPromise = mock.callbacks!.onAskUserQuestion(SAMPLE_QUESTIONS);
    manager.resolveQuestion(thread.id, { 'Which color?': 'Red' });

    const answers = await answerPromise;
    expect(answers).toEqual({ 'Which color?': 'Red' });

    await driveResponse('Done');
    await sendPromise;
  });

  it('resolveQuestion is a safe no-op when no resolver is registered', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    expect(() => manager.resolveQuestion(thread.id, { q: 'a' })).not.toThrow();
  });
});

// ─── onDone safety-net ────────────────────────────────────────────────────────

describe('pendingQuestions — onDone safety-net', () => {
  it('clears a stale pendingQuestions when the session completes normally', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    // Manually set pendingQuestions (simulates a stale value from a prior session)
    thread.pendingQuestions = SAMPLE_QUESTIONS;

    await driveResponse('Done', 'sess-1');
    await sendPromise;

    expect(thread.pendingQuestions).toBeUndefined();
  });

  it('emits pending_question_changed when safety-net clears the questions', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());
    const events: ThreadEvent[] = [];
    manager.subscribe((id, e) => { if (id === thread.id) events.push(e); });

    const sendPromise = manager.sendMessage(thread.id, 'Hi');
    thread.pendingQuestions = SAMPLE_QUESTIONS;

    await driveResponse('Done');
    await sendPromise;

    const clearEvent = events.find(e =>
      e.type === 'pending_question_changed' &&
      (e as { type: 'pending_question_changed'; questions: AskQuestion[] | undefined }).questions === undefined,
    );
    expect(clearEvent).toBeTruthy();
  });
});

// ─── setThreadPendingQuestions ────────────────────────────────────────────────

describe('setThreadPendingQuestions', () => {
  it('sets pendingQuestions on the thread', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    manager.setThreadPendingQuestions(thread.id, SAMPLE_QUESTIONS);
    expect(thread.pendingQuestions).toEqual(SAMPLE_QUESTIONS);
  });

  it('with undefined deletes pendingQuestions', () => {
    const manager = makeManager();
    const thread = manager.createThread('T', os.tmpdir());

    manager.setThreadPendingQuestions(thread.id, SAMPLE_QUESTIONS);
    manager.setThreadPendingQuestions(thread.id, undefined);
    expect(thread.pendingQuestions).toBeUndefined();
  });
});

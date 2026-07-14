/**
 * Tests for the streaming-input lifecycle fix (fix/stream-closed-permission-channel):
 *
 * ClaudeSession now always drives the SDK via a held-open async generator instead
 * of a plain string prompt. A string prompt sets the SDK's internal
 * `isSingleUserTurn` flag, which force-closes stdin — the only channel carrying
 * permission responses (canUseTool, AskUserQuestion, ExitPlanMode) — the instant
 * the first `result` event arrives. Once a background task keeps the CLI alive
 * past that first result (routine now — see task_started/task_notification
 * tracking), every later permission round-trip on a string-prompt session was
 * force-rejected with "Stream closed" even though the CLI process was still
 * running.
 *
 * The generator now only completes (which is how *we* trigger the SDK's
 * `transport.endInput()`) once no background task is pending AND no
 * task_notification landed in the same result window, re-checked on every
 * `result` event this loop sees. The notification condition was added after
 * a live probe against the real CLI (see probe-stream-closed.ts referenced
 * in the PR) showed that a fast background Bash task can start, complete,
 * AND notify entirely before the first `result` — so "no task pending" alone
 * is not a sufficient release signal; the follow-up generation that actually
 * reacts to the notification still arrives afterward and needs the channel.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';

// ─── controllable output-message channel + SDK mock ──────────────────────────
//
// A push()/close()-driven async iterable (rather than a static pre-baked
// array) so tests can pace exactly which SDK message the run() loop has
// processed before asserting on the state of the (separately, manually
// driven) input generator.

function makeChannel() {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(v: IteratorResult<Record<string, unknown>>) => void> = [];
  let closed = false;
  return {
    push(msg: Record<string, unknown>) {
      if (waiters.length > 0) waiters.shift()!({ value: msg, done: false });
      else queue.push(msg);
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()!({ value: undefined as never, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<Record<string, unknown>>> => {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  let _promptArg: unknown = null;
  let _queryIterable: AsyncIterable<Record<string, unknown>> | null = null;

  return {
    query: (opts: { prompt: unknown; options: Record<string, unknown> }) => {
      _promptArg = opts.prompt;
      const iter = _queryIterable!;
      return {
        [Symbol.asyncIterator]: () => iter[Symbol.asyncIterator](),
        close: () => {},
        interrupt: async () => {},
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => null,
      };
    },
    __setIterable: (it: AsyncIterable<Record<string, unknown>>) => { _queryIterable = it; },
    __getPromptArg: () => _promptArg,
  };
});

const { ClaudeSession } = await import('../../src/ClaudeSession');

function minimalCallbacks(overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    onToken: () => {},
    onToolUse: () => {},
    onMessage: () => {},
    onRecap: () => {},
    onDone: () => {},
    onInterrupted: () => {},
    onError: () => {},
    onPermissionRequest: async () => true,
    onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: '', title: '' }),
    ...overrides,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const successResult = (numTurns = 1) => ({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, num_turns: numTurns });

describe('ClaudeSession — prompt is always a streaming-input generator', () => {
  it('passes an AsyncIterable (not a string) for a text-only turn, yielding one user message', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = makeChannel();
    __setIterable(channel);

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hello there', undefined, '/tmp', 'default', '', minimalCallbacks());
    await tick();

    const promptArg = __getPromptArg();
    expect(typeof promptArg).not.toBe('string');
    expect(typeof (promptArg as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');

    const iter = (promptArg as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    const msg = first.value as { type: string; parent_tool_use_id: unknown; message: { role: string; content: unknown } };
    expect(msg.type).toBe('user');
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.message.role).toBe('user');
    expect(msg.message.content).toBe('hello there');

    channel.push(successResult());
    channel.close();
    await runPromise;
  });

  it('passes an AsyncIterable with text+image content blocks for an image turn', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = makeChannel();
    __setIterable(channel);

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run(
      'look at this',
      undefined,
      '/tmp',
      'default',
      '',
      minimalCallbacks(),
      undefined,
      undefined,
      [{ mediaType: 'image/png', base64: 'AAAA' }],
    );
    await tick();

    const iter = (__getPromptArg() as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    const first = await iter.next();
    const msg = first.value as { message: { content: Array<Record<string, unknown>> } };
    expect(Array.isArray(msg.message.content)).toBe(true);
    expect(msg.message.content[0]).toMatchObject({ type: 'text', text: 'look at this' });
    expect(msg.message.content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });

    channel.push(successResult());
    channel.close();
    await runPromise;
  });
});

describe('ClaudeSession — held-open input generator lifecycle', () => {
  it('completes the input generator after a result with no pending background tasks', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = makeChannel();
    __setIterable(channel);

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', minimalCallbacks());
    await tick();

    const iter = (__getPromptArg() as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    await iter.next(); // consume the initial yield

    channel.push(successResult());
    channel.close();
    await runPromise;

    const second = await iter.next();
    expect(second.done).toBe(true);
  });

  it('stays open across a result while a background task is pending, then across the result the notification lands in, completing only on the next fully-quiet result', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = makeChannel();
    __setIterable(channel);

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', minimalCallbacks());
    await tick();

    const iter = (__getPromptArg() as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    await iter.next(); // consume the initial yield

    channel.push({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'bg', skip_transcript: true, uuid: 'u1', session_id: 's' });
    channel.push(successResult());
    await tick();

    // Must still be open: race the second next() against a macrotask tick —
    // it must not resolve while the background task is pending.
    let resolvedEarly = false;
    const secondNext = iter.next().then((r) => { resolvedEarly = true; return r; });
    await Promise.race([secondNext, tick()]);
    expect(resolvedEarly).toBe(false);

    // The task notifies and a result immediately follows in the same window —
    // verified live against the real CLI (a fast background Bash task can
    // notify and resolve entirely *before* the CLI streams the follow-up
    // generation that actually reacts to it) that this is NOT yet safe to
    // release: it must survive one more full "quiet" result before we do.
    channel.push({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done', uuid: 'u2', session_id: 's' });
    channel.push(successResult(2));
    await tick();
    expect(resolvedEarly).toBe(false);

    // A subsequent result with no new task activity since the last one: now safe to release.
    channel.push(successResult(3));
    channel.close();
    await runPromise;

    const second = await secondNext;
    expect(second.done).toBe(true);
    expect(resolvedEarly).toBe(true);
  });

  it('stays open when a background task starts AND notifies before the first result (verified live: a fast Bash background task still gets a follow-up generation)', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = makeChannel();
    __setIterable(channel);

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', minimalCallbacks());
    await tick();

    const iter = (__getPromptArg() as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    await iter.next(); // consume the initial yield

    // task_started, task_updated(completed), and task_notification all land
    // before the first result — pendingBgTaskIds is already empty by result
    // time, so that alone must NOT be read as "safe to release".
    channel.push({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'bg', task_type: 'local_bash', uuid: 'u1', session_id: 's' });
    channel.push({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed' }, uuid: 'u2', session_id: 's' });
    channel.push({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done', uuid: 'u3', session_id: 's' });
    channel.push(successResult());
    await tick();

    let resolvedEarly = false;
    const secondNext = iter.next().then((r) => { resolvedEarly = true; return r; });
    await Promise.race([secondNext, tick()]);
    expect(resolvedEarly).toBe(false);

    // A follow-up generation's own result, with no new task activity since the last one.
    channel.push(successResult(2));
    channel.close();
    await runPromise;

    const second = await secondNext;
    expect(second.done).toBe(true);
    expect(resolvedEarly).toBe(true);
  });

  it('releases at the result following a notification whose reaction generation already streamed (regression: wedged-on-Working)', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = makeChannel();
    __setIterable(channel);

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', minimalCallbacks());
    await tick();

    const iter = (__getPromptArg() as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    await iter.next(); // consume the initial yield

    channel.push({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'bg', task_type: 'local_bash', uuid: 'u1', session_id: 's' });
    channel.push(successResult());
    await tick();

    // Still open: the background task is pending.
    let resolvedEarly = false;
    const secondNext = iter.next().then((r) => { resolvedEarly = true; return r; });
    await Promise.race([secondNext, tick()]);
    expect(resolvedEarly).toBe(false);

    // The dominant real-world sequence (log-verified across 14 days of raw
    // JSONL): the task notifies, the CLI streams the follow-up generation
    // reacting to it, and that generation's own result is the LAST event of
    // the turn. The assistant event IS the reaction the notification flag
    // exists to protect — once it has streamed, the result that follows must
    // release, because no further result is ever coming.
    channel.push({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done', uuid: 'u2', session_id: 's' });
    channel.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'the task finished; here is my final answer' }] }, session_id: 's' });
    channel.push(successResult(2));
    await tick();

    expect(resolvedEarly).toBe(true);
    const second = await secondNext;
    expect(second.done).toBe(true);

    channel.close();
    await runPromise;
  });

  it('does not release on a result while a background task is still running, even after an assistant event (guard: PR #290 scenario)', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = makeChannel();
    __setIterable(channel);

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', minimalCallbacks());
    await tick();

    const iter = (__getPromptArg() as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    await iter.next(); // consume the initial yield

    // A task starts and the model finishes its generation while the task is
    // still running — no notification, no terminal task_updated. The result
    // must NOT release: the CLI process is still alive doing work and the
    // next generation needs the permission channel (the original #290 bug).
    channel.push({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'bg', task_type: 'local_bash', uuid: 'u1', session_id: 's' });
    channel.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'kicked off the task, waiting' }] }, session_id: 's' });
    channel.push(successResult());
    await tick();

    let resolvedEarly = false;
    const secondNext = iter.next().then((r) => { resolvedEarly = true; return r; });
    await Promise.race([secondNext, tick()]);
    expect(resolvedEarly).toBe(false);

    session.endInput();
    const second = await secondNext;
    expect(second.done).toBe(true);

    channel.close();
    await runPromise;
  });

  it('endInput() releases a held-open generator', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = makeChannel();
    __setIterable(channel);

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', minimalCallbacks());
    await tick();

    const iter = (__getPromptArg() as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    await iter.next();

    channel.push({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'bg', skip_transcript: true, uuid: 'u1', session_id: 's' });
    channel.push(successResult());
    await tick();

    session.endInput();
    const second = await iter.next();
    expect(second.done).toBe(true);

    channel.close();
    await runPromise;
  });

  it('finally releases the input generator on a stream error', async () => {
    const { __setIterable, __getPromptArg } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const channel = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('boom')),
      }),
    };
    __setIterable(channel as AsyncIterable<Record<string, unknown>>);

    const session = new ClaudeSession('/fake/claude');
    const errors: Error[] = [];
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', minimalCallbacks({
      onError: (e) => errors.push(e),
    }));
    await tick();

    const iter = (__getPromptArg() as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    await iter.next(); // consume the initial yield; generator now suspended on `await inputReleased`

    await runPromise;
    expect(errors).toHaveLength(1);

    const second = await iter.next();
    expect(second.done).toBe(true);
  });
});

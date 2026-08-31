import { describe, it, expect, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';

function makeChannel() {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(v: IteratorResult<Record<string, unknown>>) => void> = [];
  let closed = false;
  return {
    push(msg: Record<string, unknown>) {
      if (waiters.length) waiters.shift()!({ value: msg, done: false });
      else queue.push(msg);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()!({ value: undefined as never, done: true });
    },
    [Symbol.asyncIterator]() {
      return { next: () => queue.length
        ? Promise.resolve({ value: queue.shift()!, done: false })
        : closed ? Promise.resolve({ value: undefined as never, done: true })
          : new Promise<IteratorResult<Record<string, unknown>>>((resolve) => waiters.push(resolve)) };
    },
  };
}

const sdk = vi.hoisted(() => ({ nextIterable: null as AsyncIterable<Record<string, unknown>> | null }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: () => sdk.nextIterable![Symbol.asyncIterator](),
    close: () => {}, interrupt: async () => {}, supportedModels: async () => [],
    supportedAgents: async () => [], getContextUsage: async () => null,
    setPermissionMode: async () => {}, setModel: async () => {},
  }),
}));

const { ThreadSession } = await import('../../src/ThreadSession');
const { ClaudeSession } = await import('../../src/ClaudeSession');

function callbacks(overrides: Partial<SessionCallbacks>): SessionCallbacks {
  return {
    onToken: () => {}, onToolUse: () => {}, onMessage: () => {}, onRecap: () => {},
    onDone: () => {}, onInterrupted: () => {}, onError: () => {},
    onPermissionRequest: async () => true, onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: '', title: '' }), ...overrides,
  };
}

const fallback = {
  type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry',
  scope: 'local', original_model: 'claude-opus', fallback_model: 'claude-sonnet',
  request_id: 'req-1', api_refusal_category: 'cyber', api_refusal_explanation: 'Unsafe request',
  content: 'Retried with Claude Sonnet.', uuid: 'notice-1', session_id: 's',
};
const noFallback = {
  type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-opus',
  request_id: 'req-2', api_refusal_category: 'bio', api_refusal_explanation: null,
  content: 'Claude could not answer this request.', uuid: 'notice-2', session_id: 's',
};

describe.each(['ThreadSession', 'ClaudeSession'] as const)('%s refusal protocol', (kind) => {
  it('emits typed fallback and no-fallback payloads', async () => {
    const channel = makeChannel();
    sdk.nextIterable = channel;
    const onModelRefusalFallback = vi.fn();
    const onModelRefusalNoFallback = vi.fn();
    const cb = callbacks({ onModelRefusalFallback, onModelRefusalNoFallback });
    let running: Promise<void> | undefined;
    let close: () => void;
    if (kind === 'ThreadSession') {
      const session = new ThreadSession('/fake/claude');
      await session.start({ claudePath: '/fake/claude', cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: cb } satisfies ThreadSessionOptions);
      close = () => session.close();
    } else {
      const session = new ClaudeSession('/fake/claude');
      running = session.run('hi', undefined, '/tmp', 'default', '', cb);
      close = () => session.close();
    }
    channel.push(fallback);
    channel.push(noFallback);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onModelRefusalFallback).toHaveBeenCalledWith({
      content: fallback.content, originalModel: fallback.original_model,
      fallbackModel: fallback.fallback_model, scope: 'local', category: 'cyber',
      explanation: 'Unsafe request',
    });
    expect(onModelRefusalNoFallback).toHaveBeenCalledWith({
      content: noFallback.content, originalModel: noFallback.original_model,
      category: 'bio', explanation: undefined,
    });
    close();
    channel.close();
    await running;
  });
});

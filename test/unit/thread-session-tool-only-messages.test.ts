/**
 * Regression tests for a silent data-loss bug in ThreadSession.pumpMessages'
 * `case 'assistant'` handler.
 *
 * `pendingToolCalls` collects `tool_use` blocks from the CURRENT SDK
 * `assistant` message only. Before the fix, it was flushed to
 * `thread.messages` (via `callbacks.onMessage`) ONLY if that same SDK message
 * also contained a text block — but the buffer was unconditionally cleared
 * right after, every message, not just at generation end. Claude Code
 * agentic turns routinely involve sequential, dependent tool calls (each its
 * own round-trip SDK `assistant` message with only `tool_use` blocks, no
 * text) — those tool calls rendered live via `onToolUse` but were NEVER
 * committed via `onMessage`, so they silently vanished from persisted
 * history the moment a later message flushed (or the buffer was wiped).
 *
 * The fix: flush whenever there's text OR pending tool calls, and add a
 * defensive backstop in the `finally` block so an external close() (or any
 * other early unwind) mid-generation still commits whatever tool calls were
 * collected so far.
 *
 * Mocks the SDK `query()` following the pattern in rate-limit-retry.test.ts
 * and input-stream-lifecycle.test.ts: each query() call is a "generation",
 * and a controllable async-iterable output channel feeds messages into a
 * real ThreadSession instance's pump loop.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import type { ToolCallRecord } from '../../src/types';

// ─── controllable output-message channel (mirrors input-stream-lifecycle.test.ts) ───
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

// ─── SDK mock — one entry per query() invocation ("generation") ──────────────
interface Generation {
  promptArg: AsyncIterable<Record<string, unknown>>;
  closeCalls: number;
}

const sdk = vi.hoisted(() => ({
  generations: [] as Generation[],
  nextIterable: null as AsyncIterable<Record<string, unknown>> | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (opts: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
      const gen: Generation = { promptArg: opts.prompt, closeCalls: 0 };
      sdk.generations.push(gen);
      const outputIterable = sdk.nextIterable!;
      return {
        [Symbol.asyncIterator]: () => outputIterable[Symbol.asyncIterator](),
        close: () => { gen.closeCalls += 1; },
        interrupt: async () => {},
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => null,
        setPermissionMode: vi.fn(async () => {}),
        setModel: async () => {},
      };
    },
  };
});

const { ThreadSession } = await import('../../src/ThreadSession');

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

const baseOptions = (callbacks: SessionCallbacks): ThreadSessionOptions => ({
  claudePath: '/fake/claude',
  cwd: '/tmp',
  permissionMode: 'default',
  extraEnvRaw: '',
  callbacks,
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

const successResult = (sessionId = 's', numTurns = 1) =>
  ({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0, num_turns: numTurns });

const toolUseAssistantMsg = (toolUseId: string, name = 'EnterWorktree', input: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: toolUseId, name, input },
    ],
  },
});

const textAndToolAssistantMsg = (text: string, toolUseId: string, name = 'Read', input: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool_use', id: toolUseId, name, input },
    ],
  },
});

interface CapturedMessage {
  content: string;
  toolCalls: ToolCallRecord[];
}

describe('ThreadSession — tool-only assistant messages must be persisted', () => {
  it('captures complete Claude result and rate-limit usage snapshots', async () => {
    const output = makeChannel();
    sdk.nextIterable = output;
    const onUsage = vi.fn();
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({ onUsage })));

    output.push({ type: 'rate_limit_event', rate_limit_info: {
      status: 'allowed_warning', utilization: 0.9, rateLimitType: 'five_hour', resetsAt: 2000,
    } });
    output.push({
      type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0.25, num_turns: 2,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: { sonnet: { inputTokens: 100, outputTokens: 20, costUSD: 0.25 } },
    });
    await flush();

    await expect(session.getUsageSnapshot()).resolves.toMatchObject({
      estimatedCostUsd: 0.25, turns: 2, tokens: { input: 100, output: 20 },
      quotaWindows: [{ usedPercent: 90, resetsAt: 2_000_000 }],
    });
    expect(onUsage).toHaveBeenCalledTimes(2);
    session.close();
    output.close();
  });

  it('persists a single tool-only message (no text) via onMessage, not just onToolUse', async () => {
    sdk.generations = [];
    const out = makeChannel();
    sdk.nextIterable = out;

    const messages: CapturedMessage[] = [];
    const toolUses: ToolCallRecord[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({
      onMessage: (content, toolCalls) => messages.push({ content, toolCalls }),
      onToolUse: (record) => toolUses.push(record),
    })));

    session.send('do the thing');
    await flush();

    out.push(toolUseAssistantMsg('tu-1', 'EnterWorktree', { branch: 'feat/x' }));
    await flush();

    out.push(successResult());
    await flush();

    // Rendered live regardless of the bug.
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].toolUseId).toBe('tu-1');

    // The actual regression: this tool call must ALSO have been committed to
    // persisted history via onMessage. Before the fix, `messages` is empty
    // here because parts.length === 0 for a tool-only SDK message.
    const committed = messages.filter(m => m.toolCalls.some(t => t.toolUseId === 'tu-1'));
    expect(committed.length).toBeGreaterThan(0);

    session.close();
  });

  it('persists both tool calls from two consecutive tool-only messages, even when an external close() tears down the transport before any text ever arrives', async () => {
    sdk.generations = [];
    const out = makeChannel();
    sdk.nextIterable = out;

    const messages: CapturedMessage[] = [];
    const toolUses: ToolCallRecord[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({
      onMessage: (content, toolCalls) => messages.push({ content, toolCalls }),
      onToolUse: (record) => toolUses.push(record),
    })));

    session.send('set up two worktrees');
    await flush();

    // Two consecutive round-trip SDK assistant messages, each carrying ONLY a
    // tool_use block — mirroring two real-world EnterWorktree calls, each
    // needing its own round trip because the model must see one result
    // before deciding the next action.
    out.push(toolUseAssistantMsg('tu-1', 'EnterWorktree', { branch: 'feat/a' }));
    await flush();
    out.push(toolUseAssistantMsg('tu-2', 'EnterWorktree', { branch: 'feat/b' }));
    await flush();

    // No text-bearing message ever arrives — instead, something external
    // (simulating the separate cwd-restart-hang bug tearing down the
    // transport) closes the session out from under the pump loop.
    session.close();
    out.close();
    await flush();

    expect(toolUses.map(t => t.toolUseId)).toEqual(['tu-1', 'tu-2']);

    // Both tool calls must have been committed — not just rendered live —
    // despite generation ending with neither a text block nor a clean result.
    const committedToolUseIds = new Set(
      messages.flatMap(m => m.toolCalls.map(t => t.toolUseId)),
    );
    expect(committedToolUseIds.has('tu-1')).toBe(true);
    expect(committedToolUseIds.has('tu-2')).toBe(true);
  });

  it('does not regress the normal case: text + tool_use in the same SDK message produce one combined onMessage call', async () => {
    sdk.generations = [];
    const out = makeChannel();
    sdk.nextIterable = out;

    const messages: CapturedMessage[] = [];
    const session = new ThreadSession('/fake/claude');
    await session.start(baseOptions(minimalCallbacks({
      onMessage: (content, toolCalls) => messages.push({ content, toolCalls }),
    })));

    session.send('read a file');
    await flush();

    out.push(textAndToolAssistantMsg('Let me check that file.', 'tu-1', 'Read', { path: '/tmp/x.ts' }));
    await flush();

    out.push(successResult());
    await flush();

    // Exactly one combined message — not split into a text-only message and
    // a separate tool-only message.
    const withThisTool = messages.filter(m => m.toolCalls.some(t => t.toolUseId === 'tu-1'));
    expect(withThisTool).toHaveLength(1);
    expect(withThisTool[0].content).toBe('Let me check that file.');
    expect(withThisTool[0].toolCalls).toHaveLength(1);
    expect(withThisTool[0].toolCalls[0].toolUseId).toBe('tu-1');

    session.close();
  });
});

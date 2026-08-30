/**
 * Both session pumps scan `tool_result` blocks for inline images and hand them
 * to `callbacks.onToolResultImages`. They only ever matched the Anthropic
 * content-block shape (`{ type:'image', source:{ type:'base64', media_type,
 * data } }`).
 *
 * MCP tools emit a different shape: `{ type:'image', data, mimeType }`. The
 * SDK/CLI is expected to normalise one into the other, but no built-in tool
 * returns an image today, so that conversion is unproven. If it ever doesn't
 * happen, the image is dropped on the floor with no error. These tests
 * pin the defensive second branch on BOTH scanners (they are duplicated logic
 * in two classes, so one can regress without the other).
 *
 * Drives real ThreadSession / ClaudeSession instances through a mocked SDK
 * `query()`, following the channel pattern in
 * thread-session-tool-only-messages.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { ThreadSessionOptions } from '../../src/ThreadSession';

// ─── controllable output-message channel ────────────────────────────────────
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

const sdk = vi.hoisted(() => ({
  nextIterable: null as AsyncIterable<Record<string, unknown>> | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const outputIterable = sdk.nextIterable!;
    return {
      [Symbol.asyncIterator]: () => outputIterable[Symbol.asyncIterator](),
      close: () => {},
      interrupt: async () => {},
      supportedModels: async () => [],
      supportedAgents: async () => [],
      getContextUsage: async () => null,
      setPermissionMode: vi.fn(async () => {}),
      setModel: async () => {},
    };
  },
}));

const { ThreadSession } = await import('../../src/ThreadSession');
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

/** A `user` message carrying one `tool_result` whose content is `blocks`. */
const toolResultMsg = (blocks: Array<Record<string, unknown>>) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: blocks }],
  },
});

const ANTHROPIC_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
};
const MCP_BLOCK = { type: 'image', data: 'WFla', mimeType: 'image/jpeg' };
const UNRECOGNISED_BLOCK = { type: 'image', source: { type: 'url', url: 'https://x/y.png' } };

/** Pump `blocks` through a live ThreadSession and return what the scanner emitted. */
async function scanWithThreadSession(blocks: Array<Record<string, unknown>>) {
  const output = makeChannel();
  sdk.nextIterable = output;
  const onToolResultImages = vi.fn();
  const session = new ThreadSession('/fake/claude');
  await session.start(baseOptions(minimalCallbacks({ onToolResultImages })));

  output.push(toolResultMsg(blocks));
  output.push({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, num_turns: 1 });
  await flush();

  session.close();
  output.close();
  return onToolResultImages;
}

/** Same, for ClaudeSession, whose entry point is `run()` rather than `start()`. */
async function scanWithClaudeSession(blocks: Array<Record<string, unknown>>) {
  const output = makeChannel();
  sdk.nextIterable = output;
  const onToolResultImages = vi.fn();
  const session = new ClaudeSession('/fake/claude');

  const running = session.run('hi', undefined, '/tmp', 'default', '', minimalCallbacks({ onToolResultImages }));
  await flush();

  output.push(toolResultMsg(blocks));
  output.push({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, num_turns: 1 });
  output.close();
  await running;
  return onToolResultImages;
}

const scanners: Array<[string, (b: Array<Record<string, unknown>>) => Promise<ReturnType<typeof vi.fn>>]> = [
  ['ThreadSession', scanWithThreadSession],
  ['ClaudeSession', scanWithClaudeSession],
];

describe.each(scanners)('%s tool-result image scanner', (_name, scan) => {
  it('accepts the Anthropic content-block shape', async () => {
    const onToolResultImages = await scan([ANTHROPIC_BLOCK]);
    expect(onToolResultImages).toHaveBeenCalledWith([{ mediaType: 'image/png', data: 'QUJD' }]);
  });

  it('accepts the MCP { data, mimeType } shape', async () => {
    const onToolResultImages = await scan([MCP_BLOCK]);
    expect(onToolResultImages).toHaveBeenCalledWith([{ mediaType: 'image/jpeg', data: 'WFla' }]);
  });

  it('accepts a mix of both shapes in one tool result, in order', async () => {
    const onToolResultImages = await scan([ANTHROPIC_BLOCK, MCP_BLOCK]);
    expect(onToolResultImages).toHaveBeenCalledWith([
      { mediaType: 'image/png', data: 'QUJD' },
      { mediaType: 'image/jpeg', data: 'WFla' },
    ]);
  });

  it('ignores non-image blocks and image blocks in neither shape', async () => {
    const onToolResultImages = await scan([{ type: 'text', text: 'no image here' }, UNRECOGNISED_BLOCK]);
    expect(onToolResultImages).not.toHaveBeenCalled();
  });
});

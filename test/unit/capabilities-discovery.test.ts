/**
 * Tests for Group 5 dynamic discovery + context usage:
 *   - supportedModels() / supportedAgents() fire onCapabilitiesDiscovered
 *   - getContextUsage() returns the SDK response (or null when no session)
 *   - /context slash command is in THREAD_BUILTIN_COMMANDS
 */

import { describe, it, expect, vi } from 'vitest';
import { THREAD_BUILTIN_COMMANDS } from '../../src/slashCommands';

// ─── /context in slash-command list ──────────────────────────────────────────

describe('THREAD_BUILTIN_COMMANDS — /context', () => {
  it("includes 'context' command", () => {
    const names = THREAD_BUILTIN_COMMANDS.map((c) => c.name);
    expect(names).toContain('context');
  });

  it('/context has a non-empty description', () => {
    const cmd = THREAD_BUILTIN_COMMANDS.find((c) => c.name === 'context');
    expect(cmd?.description).toBeTruthy();
  });
});

// ─── onCapabilitiesDiscovered ─────────────────────────────────────────────────

// We need to mock the SDK here so supportedModels / supportedAgents resolve
// with fixture data without spawning a real subprocess.

const capMock = vi.hoisted(() => ({
  models: [{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' }] as unknown[],
  agents: [{ id: 'code', displayName: 'Code agent' }] as unknown[],
  getContextUsageResult: {
    system_prompt: { tokens: 500 },
    messages: { tokens: 1200 },
    tools: { tokens: 200 },
  } as unknown,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  let _queryIterable: AsyncIterable<Record<string, unknown>> | null = null;
  return {
    query: (_opts: unknown) => ({
      [Symbol.asyncIterator]: () => _queryIterable![Symbol.asyncIterator](),
      close: () => {},
      interrupt: async () => {},
      supportedModels: async () => capMock.models,
      supportedAgents: async () => capMock.agents,
      getContextUsage: async () => capMock.getContextUsageResult,
    }),
    __setIterable: (it: AsyncIterable<Record<string, unknown>>) => { _queryIterable = it; },
  };
});

const { ClaudeSession } = await import('../../src/ClaudeSession');

async function* makeMessages(msgs: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  for (const m of msgs) yield m;
}

// ─── supportedModels / supportedAgents ────────────────────────────────────────

describe('onCapabilitiesDiscovered', () => {
  it('fires after session init with model and agent lists', async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    __setIterable(makeMessages([
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const discovered: { models: unknown[]; agents: unknown[] }[] = [];
    const session = new ClaudeSession('/fake/claude');
    await session.run('hi', undefined, '/tmp', 'default', '', {
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
      onCapabilitiesDiscovered: (models, agents) => discovered.push({ models, agents }),
    });

    // Discovery is async (fire-and-forget), so we need to flush the microtask queue
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(discovered).toHaveLength(1);
    expect(discovered[0].models).toHaveLength(1);
    expect((discovered[0].models[0] as { id: string }).id).toBe('claude-sonnet-4-5');
    expect(discovered[0].agents).toHaveLength(1);
    expect((discovered[0].agents[0] as { id: string }).id).toBe('code');
  });

  it('does NOT fire onCapabilitiesDiscovered when the callback is not registered', async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    __setIterable(makeMessages([
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    // No onCapabilitiesDiscovered registered — must not throw
    const session = new ClaudeSession('/fake/claude');
    await expect(
      session.run('hi', undefined, '/tmp', 'default', '', {
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
      }),
    ).resolves.not.toThrow();
  });
});

// ─── getContextUsage ──────────────────────────────────────────────────────────

describe('ClaudeSession.getContextUsage', () => {
  it('returns null when no session is active', async () => {
    const session = new ClaudeSession('/fake/claude');
    const result = await session.getContextUsage();
    expect(result).toBeNull();
  });

  it('returns the SDK usage response during an active session', async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;

    // Use a promise to pause the session mid-run so we can call getContextUsage
    let pauseResolve: (() => void) | null = null;

    __setIterable((async function* () {
      // Wait for test to call getContextUsage before yielding the result
      await new Promise<void>((r) => { pauseResolve = r; });
      yield { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 };
    })());

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', {
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
    });

    // Wait for the session to start iterating (so activeQuery is set)
    await new Promise<void>((r) => setTimeout(r, 0));

    const usage = await session.getContextUsage();
    expect(usage).not.toBeNull();
    expect(usage).toHaveProperty('system_prompt');
    expect(usage).toHaveProperty('messages');

    // Resume the session so it can complete
    pauseResolve!();
    await runPromise;
  });
});

// ─── ThreadManager.getContextUsage ───────────────────────────────────────────

describe('ThreadManager.getContextUsage', () => {
  it('returns null for a thread with no active session', async () => {
    const { ThreadManager } = await import('../../src/ThreadManager');
    const { DEFAULT_SETTINGS } = await import('../../src/types');
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const thread = manager.createThread('T');
    const result = await manager.getContextUsage(thread.id);
    expect(result).toBeNull();
  });
});

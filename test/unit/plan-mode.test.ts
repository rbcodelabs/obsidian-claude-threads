/**
 * Tests for Group 4 Plan Mode:
 *   - canUseTool('EnterPlanMode') → { behavior: 'allow' } and fires onEnterPlanMode
 *   - canUseTool('ExitPlanMode') → does NOT immediately resolve
 *   - approve() callback from onPlanReady → canUseTool resolves { behavior: 'deny', interrupt: false }
 *     (ExitPlanMode must NOT be allowed to execute: the CLI Zod schema rejects the extra `plan`
 *      field Claude sends in the input. We signal approval via a non-interrupting deny message.)
 *   - reject() callback from onPlanReady → canUseTool resolves { behavior: 'deny', interrupt: true }
 *
 * These are tested through ClaudeSession directly (not ThreadManager) because
 * the plan-mode logic lives in ClaudeSession.canUseTool.  We drive the SDK
 * event stream so that EnterPlanMode / ExitPlanMode tool_use blocks fire the
 * real canUseTool callback chain.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';

// ─── mock the SDK query so we can inject synthetic tool_use blocks ───────────

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  // Capture the canUseTool function so tests can call it directly.
  let _canUseTool: ((name: string, input: unknown, opts: Record<string, unknown>) => Promise<unknown>) | null = null;
  let _queryIterable: AsyncIterable<Record<string, unknown>> | null = null;

  return {
    query: (opts: { options: { canUseTool?: unknown; prompt: unknown } }) => {
      _canUseTool = opts.options?.canUseTool as typeof _canUseTool;
      const iter = _queryIterable;
      return {
        [Symbol.asyncIterator]: () => iter![Symbol.asyncIterator](),
        close: () => {},
        interrupt: async () => {},
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => null,
      };
    },
    __setIterable: (it: AsyncIterable<Record<string, unknown>>) => { _queryIterable = it; },
    __getCanUseTool: () => _canUseTool,
  };
});

const { ClaudeSession } = await import('../../src/ClaudeSession');

async function* makeMessages(msgs: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  for (const m of msgs) yield m;
}

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

// ─── EnterPlanMode ────────────────────────────────────────────────────────────

describe('canUseTool EnterPlanMode', () => {
  it("returns { behavior: 'allow' } immediately and fires onEnterPlanMode", async () => {
    const { __setIterable, __getCanUseTool } = await import('@anthropic-ai/claude-agent-sdk') as any;

    __setIterable(makeMessages([
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sess',
        total_cost_usd: 0,
        num_turns: 1,
      },
    ]));

    const enterPlanCalled: boolean[] = [];
    const callbacks = minimalCallbacks({
      onEnterPlanMode: () => enterPlanCalled.push(true),
    });

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', callbacks);

    // Wait a tick for the session to initialize and register canUseTool
    await new Promise<void>((r) => setTimeout(r, 0));

    const canUseTool = __getCanUseTool() as (
      name: string,
      input: unknown,
      opts: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;

    expect(canUseTool).not.toBeNull();

    const result = await canUseTool('EnterPlanMode', {}, {});
    expect(result.behavior).toBe('allow');
    expect(enterPlanCalled).toHaveLength(1);

    await runPromise;
  });

  it('does NOT call onPlanReady for EnterPlanMode', async () => {
    const { __setIterable, __getCanUseTool } = await import('@anthropic-ai/claude-agent-sdk') as any;

    __setIterable(makeMessages([
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const planReadyCalled: boolean[] = [];
    const callbacks = minimalCallbacks({
      onEnterPlanMode: () => {},
      onPlanReady: () => planReadyCalled.push(true),
    });

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', callbacks);
    await new Promise<void>((r) => setTimeout(r, 0));

    const canUseTool = __getCanUseTool() as (name: string, input: unknown, opts: Record<string, unknown>) => Promise<unknown>;
    await canUseTool('EnterPlanMode', {}, {});

    await runPromise;
    expect(planReadyCalled).toHaveLength(0);
  });
});

// ─── ExitPlanMode ─────────────────────────────────────────────────────────────

describe('canUseTool ExitPlanMode', () => {
  it("does not immediately resolve — blocks until approve() is called", async () => {
    const { __setIterable, __getCanUseTool } = await import('@anthropic-ai/claude-agent-sdk') as any;

    __setIterable(makeMessages([
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    let approveRef: ((edited?: string) => void) | null = null;
    const callbacks = minimalCallbacks({
      onPlanReady: (_planText, approve, _reject) => {
        approveRef = approve;
        // Do NOT call approve/reject yet
      },
    });

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', callbacks);
    await new Promise<void>((r) => setTimeout(r, 0));

    const canUseTool = __getCanUseTool() as (name: string, input: unknown, opts: Record<string, unknown>) => Promise<{ behavior: string }>;

    let resolved = false;
    const callPromise = canUseTool('ExitPlanMode', { plan: 'Step 1: do X' }, {}).then(r => {
      resolved = true;
      return r;
    });

    // Yield to microtask queue — promise must still be pending
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);

    // Now approve — returns deny+no-interrupt to avoid Zod error on ExitPlanMode execution
    approveRef!();
    const result = await callPromise;
    expect(result.behavior).toBe('deny');
    expect((result as any).interrupt).toBe(false);

    await runPromise;
  });

  it("approve() makes canUseTool resolve with { behavior: 'deny', interrupt: false } (avoids Zod error on ExitPlanMode execution)", async () => {
    const { __setIterable, __getCanUseTool } = await import('@anthropic-ai/claude-agent-sdk') as any;

    __setIterable(makeMessages([
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    let approveRef: ((edited?: string) => void) | null = null;
    const callbacks = minimalCallbacks({
      onPlanReady: (_planText, approve, _reject) => { approveRef = approve; },
    });

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', callbacks);
    await new Promise<void>((r) => setTimeout(r, 0));

    const canUseTool = __getCanUseTool() as (name: string, input: unknown, opts: Record<string, unknown>) => Promise<{ behavior: string }>;
    const callPromise = canUseTool('ExitPlanMode', { plan: 'Step 1: do X\nStep 2: do Y' }, {});

    await new Promise<void>((r) => setTimeout(r, 0));
    approveRef!();

    const result = await callPromise;
    // Approve signals via deny+no-interrupt so the CLI never tries to execute
    // ExitPlanMode (which fails with a Zod schema error on the extra `plan` field).
    expect(result.behavior).toBe('deny');
    expect((result as any).interrupt).toBe(false);
    expect((result as any).message).toContain('approved');

    await runPromise;
  });

  it("reject() makes canUseTool resolve with { behavior: 'deny' }", async () => {
    const { __setIterable, __getCanUseTool } = await import('@anthropic-ai/claude-agent-sdk') as any;

    __setIterable(makeMessages([
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    let rejectRef: (() => void) | null = null;
    const callbacks = minimalCallbacks({
      onPlanReady: (_planText, _approve, reject) => { rejectRef = reject; },
    });

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', callbacks);
    await new Promise<void>((r) => setTimeout(r, 0));

    const canUseTool = __getCanUseTool() as (name: string, input: unknown, opts: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;
    const callPromise = canUseTool('ExitPlanMode', { plan: 'A plan I reject' }, {});

    await new Promise<void>((r) => setTimeout(r, 0));
    rejectRef!();

    const result = await callPromise;
    expect(result.behavior).toBe('deny');
    expect((result as any).interrupt).toBe(false);
    expect((result as any).message).toContain('rejected');

    await runPromise;
  });

  it('fires onPlanReady with the plan text from input.plan', async () => {
    const { __setIterable, __getCanUseTool } = await import('@anthropic-ai/claude-agent-sdk') as any;

    __setIterable(makeMessages([
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    let receivedPlan: string | null = null;
    const callbacks = minimalCallbacks({
      onPlanReady: (planText, approve, _reject) => {
        receivedPlan = planText;
        approve();
      },
    });

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', callbacks);
    await new Promise<void>((r) => setTimeout(r, 0));

    const canUseTool = __getCanUseTool() as (name: string, input: unknown, opts: Record<string, unknown>) => Promise<unknown>;
    await canUseTool('ExitPlanMode', { plan: 'Step 1: research\nStep 2: implement' }, {});

    await runPromise;
    expect(receivedPlan).toBe('Step 1: research\nStep 2: implement');
  });

  it("no-handler ExitPlanMode resolves with { behavior: 'deny', interrupt: false } to avoid Zod execution error", async () => {
    const { __setIterable, __getCanUseTool } = await import('@anthropic-ai/claude-agent-sdk') as any;

    __setIterable(makeMessages([
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    // No onPlanReady registered
    const callbacks = minimalCallbacks({});

    const session = new ClaudeSession('/fake/claude');
    const runPromise = session.run('hi', undefined, '/tmp', 'default', '', callbacks);
    await new Promise<void>((r) => setTimeout(r, 0));

    const canUseTool = __getCanUseTool() as (name: string, input: unknown, opts: Record<string, unknown>) => Promise<{ behavior: string }>;
    const result = await canUseTool('ExitPlanMode', { plan: 'plan text' }, {});
    expect(result.behavior).toBe('deny');
    expect((result as any).interrupt).toBe(false);

    await runPromise;
  });
});

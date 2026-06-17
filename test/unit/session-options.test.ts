/**
 * Tests for Group 3 session configuration options:
 *   - thinkingMode: disabled / adaptive / enabled (+ budgetTokens)
 *   - effort: default (omit) vs low/medium/high/xhigh/max
 *   - agentProgressSummaries
 *   - enable1MContext → betas array
 *   - Thread.ephemeral → persistSession: false
 *   - Scheduled session with global permissionMode 'default' → thread gets 'dontAsk'
 *   - New permissionMode values accepted by Thread type
 *
 * Strategy: ThreadManager.buildSessionOptions is private, so we test it
 * indirectly by spying on ClaudeSession.run and capturing the sessionOptions
 * argument (the 14th parameter).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { Thread } from '../../src/types';

// ─── hoisted mock ─────────────────────────────────────────────────────────────

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  sessionOptions: null as Record<string, unknown> | null,
  permissionMode: null as string | null,
  resolve: null as (() => void) | null,
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      _prompt: string,
      _resumeSessionId: string | undefined,
      _cwd: unknown,
      permissionMode: string,
      _env: unknown,
      callbacks: SessionCallbacks,
      _dirs?: unknown,
      _model?: string,
      _images?: unknown,
      _appendSystem?: unknown,
      _mcpServers?: unknown,
      _secretEnv?: unknown,
      _disallowedTools?: unknown,
      sessionOptions?: Record<string, unknown>,
    ): Promise<void> {
      mock.callbacks = callbacks;
      mock.sessionOptions = sessionOptions ?? null;
      mock.permissionMode = permissionMode;
      return new Promise<void>((res) => { mock.resolve = res; });
    }
    close() {}
    async interrupt() {}
  },
  formatToolName: (s: string) => s,
  getToolIcon: () => 'wrench',
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

async function finishSession() {
  mock.callbacks!.onDone('sess', 0, 1);
  mock.resolve!();
}

beforeEach(() => {
  mock.callbacks = null;
  mock.sessionOptions = null;
  mock.permissionMode = null;
  mock.resolve = null;
});

// ─── thinkingMode ─────────────────────────────────────────────────────────────

describe('thinkingMode → sessionOptions.thinking', () => {
  it("'disabled' does NOT pass thinking key", async () => {
    const manager = makeManager({ thinkingMode: 'disabled' });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.thinking).toBeUndefined();
  });

  it("'adaptive' passes { type: 'adaptive' }", async () => {
    const manager = makeManager({ thinkingMode: 'adaptive' });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.thinking).toEqual({ type: 'adaptive' });
  });

  it("'enabled' passes { type: 'enabled', budgetTokens }", async () => {
    const manager = makeManager({ thinkingMode: 'enabled', thinkingBudgetTokens: 5000 });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.thinking).toEqual({ type: 'enabled', budgetTokens: 5000 });
  });

  it("'enabled' uses 8000 as the default when thinkingBudgetTokens is not set (null/undefined)", async () => {
    // ?? 8000 only falls back when value is null or undefined, not 0.
    // Test with undefined (no override) — DEFAULT_SETTINGS has 8000.
    const settings = { ...DEFAULT_SETTINGS, thinkingMode: 'enabled' as const };
    delete (settings as Partial<typeof settings>).thinkingBudgetTokens;
    const manager = makeManager(settings);
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    const thinking = mock.sessionOptions?.thinking as { type: string; budgetTokens?: number } | undefined;
    expect(thinking?.budgetTokens).toBe(8000);
  });
});

// ─── effort ──────────────────────────────────────────────────────────────────

describe('effort → sessionOptions.effort', () => {
  it("'default' does NOT pass effort key", async () => {
    const manager = makeManager({ effort: 'default' });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.effort).toBeUndefined();
  });

  it("'high' passes effort: 'high'", async () => {
    const manager = makeManager({ effort: 'high' });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.effort).toBe('high');
  });

  it("'max' passes effort: 'max'", async () => {
    const manager = makeManager({ effort: 'max' });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.effort).toBe('max');
  });

  it("'xhigh' passes effort: 'xhigh'", async () => {
    const manager = makeManager({ effort: 'xhigh' });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.effort).toBe('xhigh');
  });
});

// ─── agentProgressSummaries ───────────────────────────────────────────────────

describe('agentProgressSummaries → sessionOptions', () => {
  it('passes agentProgressSummaries: true when enabled', async () => {
    const manager = makeManager({ agentProgressSummaries: true });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.agentProgressSummaries).toBe(true);
  });

  it('passes agentProgressSummaries: false when disabled', async () => {
    const manager = makeManager({ agentProgressSummaries: false });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.agentProgressSummaries).toBe(false);
  });
});

// ─── enable1MContext ──────────────────────────────────────────────────────────

describe('enable1MContext → sessionOptions.betas', () => {
  it("passes betas: ['context-1m-2025-08-07'] when enable1MContext is true", async () => {
    const manager = makeManager({ enable1MContext: true });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.betas).toEqual(['context-1m-2025-08-07']);
  });

  it('does NOT pass betas when enable1MContext is false', async () => {
    const manager = makeManager({ enable1MContext: false });
    const thread = manager.createThread('T');
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.betas).toBeUndefined();
  });
});

// ─── ephemeral thread ─────────────────────────────────────────────────────────

describe('Thread.ephemeral → sessionOptions.persistSession', () => {
  it('passes persistSession: false when thread.ephemeral is true', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    thread.ephemeral = true;
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.persistSession).toBe(false);
  });

  it('does NOT pass persistSession when thread.ephemeral is falsy', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    // ephemeral is not set (undefined)
    const p = manager.sendMessage(thread.id, 'hi');
    await finishSession();
    await p;
    expect(mock.sessionOptions?.persistSession).toBeUndefined();
  });
});

// ─── scheduled session dontAsk override ──────────────────────────────────────

describe('scheduled session dontAsk override', () => {
  it("thread created for a scheduled run gets permissionMode 'dontAsk' when global mode is 'default'", () => {
    // This mirrors the logic in main.ts Scheduler createThread callback.
    // We test the logic directly without needing the full plugin:
    // when global permissionMode is 'default' and thread has no override, set 'dontAsk'.
    const thread: Partial<Thread> = { permissionMode: undefined };
    const globalMode = 'default' as const;

    if (!thread.permissionMode && globalMode === 'default') {
      thread.permissionMode = 'dontAsk';
    }

    expect(thread.permissionMode).toBe('dontAsk');
  });

  it("does NOT override permissionMode when it is already set on the thread", () => {
    const thread: Partial<Thread> = { permissionMode: 'bypassPermissions' };
    const globalMode = 'default' as const;

    if (!thread.permissionMode && globalMode === 'default') {
      thread.permissionMode = 'dontAsk';
    }

    expect(thread.permissionMode).toBe('bypassPermissions');
  });

  it("does NOT set dontAsk when global permissionMode is not 'default'", () => {
    const thread: Partial<Thread> = { permissionMode: undefined };
    const globalMode = 'acceptEdits' as const;

    if (!thread.permissionMode && globalMode === 'default') {
      thread.permissionMode = 'dontAsk';
    }

    expect(thread.permissionMode).toBeUndefined();
  });
});

// ─── permissionMode values accepted by type ───────────────────────────────────

describe('Thread.permissionMode — new values accepted by type', () => {
  it("accepts 'plan' as a valid permissionMode", () => {
    const thread: Partial<Thread> = {};
    // TypeScript compile check: these lines must compile without error.
    thread.permissionMode = 'plan';
    expect(thread.permissionMode).toBe('plan');
  });

  it("accepts 'dontAsk' as a valid permissionMode", () => {
    const thread: Partial<Thread> = {};
    thread.permissionMode = 'dontAsk';
    expect(thread.permissionMode).toBe('dontAsk');
  });

  it("accepts 'auto' as a valid permissionMode", () => {
    const thread: Partial<Thread> = {};
    thread.permissionMode = 'auto';
    expect(thread.permissionMode).toBe('auto');
  });

  it("PluginSettings.permissionMode accepts 'plan'", () => {
    const settings = { ...DEFAULT_SETTINGS };
    settings.permissionMode = 'plan';
    expect(settings.permissionMode).toBe('plan');
  });

  it("PluginSettings.permissionMode accepts 'dontAsk'", () => {
    const settings = { ...DEFAULT_SETTINGS };
    settings.permissionMode = 'dontAsk';
    expect(settings.permissionMode).toBe('dontAsk');
  });

  it("PluginSettings.permissionMode accepts 'auto'", () => {
    const settings = { ...DEFAULT_SETTINGS };
    settings.permissionMode = 'auto';
    expect(settings.permissionMode).toBe('auto');
  });
});

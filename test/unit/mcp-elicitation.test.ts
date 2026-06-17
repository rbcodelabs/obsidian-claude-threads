/**
 * Tests for Group 6 MCP elicitation:
 *   - onElicitation registered in query options when callback is provided
 *   - URL-mode elicitation request fires callback with request and signal
 *   - Form-mode elicitation request fires callback with request and schema
 *   - ThreadManager surfaces elicitation as an elicitation_request ThreadEvent
 *   - respond() callback resolves the blocking promise
 *
 * All tests use the ClaudeSession mock pattern (same as background-task-notifications).
 * The "onElicitation registered in query options" assertion is made by verifying
 * that ClaudeSession.run() receives and routes elicitation requests correctly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// ─── hoisted mock ─────────────────────────────────────────────────────────────

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  resolve: null as (() => void) | null,
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      _prompt: string,
      _resumeSessionId: string | undefined,
      _cwd: unknown,
      _mode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
    ): Promise<void> {
      mock.callbacks = callbacks;
      return new Promise<void>((res) => { mock.resolve = res; });
    }
    close() {}
    async interrupt() {}
  },
  formatToolName: (s: string) => s,
  getToolIcon: () => 'wrench',
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager() {
  return new ThreadManager({ ...DEFAULT_SETTINGS });
}

async function finishSession() {
  mock.callbacks!.onDone('sess', 0, 1);
  mock.resolve!();
}

beforeEach(() => {
  mock.callbacks = null;
  mock.resolve = null;
});

// ─── onElicitation registration (via ThreadManager) ──────────────────────────

describe('onElicitation registration', () => {
  it('ThreadManager passes onElicitation callback to ClaudeSession', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const sendP = manager.sendMessage(thread.id, 'hi');
    await new Promise<void>((r) => setTimeout(r, 0));

    // ThreadManager always registers onElicitation so it can emit events.
    expect(mock.callbacks).not.toBeNull();
    expect(typeof mock.callbacks!.onElicitation).toBe('function');

    await finishSession();
    await sendP;
  });
});

// ─── URL elicitation ─────────────────────────────────────────────────────────

describe('URL elicitation → elicitation_request ThreadEvent', () => {
  it('emits elicitation_request event with correct URL request fields', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    await new Promise<void>((r) => setTimeout(r, 0));

    const urlRequest = {
      serverName: 'github',
      type: 'url' as const,
      url: 'https://github.com/auth',
      title: 'GitHub OAuth',
      message: 'Please authenticate to continue',
    };

    let elicitResolved = false;
    const elicitPromise = mock.callbacks!.onElicitation!(
      urlRequest as never,
      new AbortController().signal,
    ).then(() => { elicitResolved = true; });

    await new Promise<void>((r) => setTimeout(r, 0));

    const evt = events.find(e => e.type === 'elicitation_request') as
      Extract<ThreadEvent, { type: 'elicitation_request' }> | undefined;

    expect(evt).toBeDefined();
    const req = evt!.request as typeof urlRequest;
    expect(req.type).toBe('url');
    expect(req.url).toBe('https://github.com/auth');
    expect(req.title).toBe('GitHub OAuth');
    expect(req.serverName).toBe('github');
    expect(typeof evt!.respond).toBe('function');

    evt!.respond({ action: 'cancel' });
    await elicitPromise;
    expect(elicitResolved).toBe(true);

    await finishSession();
    await sendP;
  });

  it('passes the AbortSignal through to the elicitation_request event', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    await new Promise<void>((r) => setTimeout(r, 0));

    const controller = new AbortController();
    const elicitPromise = mock.callbacks!.onElicitation!(
      { serverName: 'x', type: 'url', url: 'https://x.com' } as never,
      controller.signal,
    );

    await new Promise<void>((r) => setTimeout(r, 0));

    const evt = events.find(e => e.type === 'elicitation_request') as
      Extract<ThreadEvent, { type: 'elicitation_request' }> | undefined;

    expect(evt).toBeDefined();
    expect(evt!.signal).toBe(controller.signal);

    evt!.respond({ action: 'cancel' });
    await elicitPromise;

    await finishSession();
    await sendP;
  });
});

// ─── Form elicitation ─────────────────────────────────────────────────────────

describe('Form elicitation → elicitation_request ThreadEvent', () => {
  it('emits elicitation_request event with form request and schema', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    await new Promise<void>((r) => setTimeout(r, 0));

    const formRequest = {
      serverName: 'jira-mcp',
      type: 'form' as const,
      title: 'Jira credentials',
      message: 'Enter your Jira API token',
      requestedSchema: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Jira username' },
          apiToken: { type: 'string', description: 'Jira API token' },
        },
        required: ['username', 'apiToken'],
      },
    };

    const elicitPromise = mock.callbacks!.onElicitation!(
      formRequest as never,
      new AbortController().signal,
    );

    await new Promise<void>((r) => setTimeout(r, 0));

    const evt = events.find(e => e.type === 'elicitation_request') as
      Extract<ThreadEvent, { type: 'elicitation_request' }> | undefined;

    expect(evt).toBeDefined();
    const req = evt!.request as typeof formRequest;
    expect(req.type).toBe('form');
    expect(req.serverName).toBe('jira-mcp');
    expect(req.requestedSchema.properties).toHaveProperty('username');
    expect(req.requestedSchema.properties).toHaveProperty('apiToken');
    expect(req.requestedSchema.required).toContain('username');

    evt!.respond({ action: 'cancel' });
    await elicitPromise;

    await finishSession();
    await sendP;
  });
});

// ─── respond() mechanics ─────────────────────────────────────────────────────

describe('elicitation respond() callback', () => {
  it('blocks the elicitation promise until respond() is called', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    await new Promise<void>((r) => setTimeout(r, 0));

    let resolved = false;
    const elicitPromise = mock.callbacks!.onElicitation!(
      { serverName: 'x', type: 'url', url: 'https://x.com' } as never,
      new AbortController().signal,
    ).then(() => { resolved = true; });

    // Flush — promise should still be pending
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    const evt = events.find(e => e.type === 'elicitation_request') as
      Extract<ThreadEvent, { type: 'elicitation_request' }> | undefined;
    evt!.respond({ action: 'cancel' });

    await elicitPromise;
    expect(resolved).toBe(true);

    await finishSession();
    await sendP;
  });

  it('passes the result from respond() back to the caller', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    await new Promise<void>((r) => setTimeout(r, 0));

    let result: unknown = null;
    const elicitPromise = mock.callbacks!.onElicitation!(
      { serverName: 'x', type: 'url', url: 'https://x.com' } as never,
      new AbortController().signal,
    ).then((r) => { result = r; });

    await new Promise<void>((r) => setTimeout(r, 0));

    const evt = events.find(e => e.type === 'elicitation_request') as
      Extract<ThreadEvent, { type: 'elicitation_request' }> | undefined;

    const submitResult = { action: 'submit', data: { username: 'rick' } };
    evt!.respond(submitResult);
    await elicitPromise;

    expect(result).toEqual(submitResult);

    await finishSession();
    await sendP;
  });
});

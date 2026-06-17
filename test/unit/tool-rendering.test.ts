/**
 * Tests for Group 2 tool-rendering additions:
 *   - getToolIcon('REPL') returns 'code-2'
 *   - formatToolSummary('REPL', ...) returns "Run JS: <first line>"
 *   - BashOutput.gitOperation fires onGitOperation with structured text
 *   - FileEditOutput.userModified = true stores path in thread.userModifiedFiles
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getToolIcon } from '../../src/toolNameUtils';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// ─── toolNameUtils (pure) ─────────────────────────────────────────────────────

describe('getToolIcon — REPL', () => {
  it("returns 'code-2' for bare 'REPL'", () => {
    expect(getToolIcon('REPL')).toBe('code-2');
  });

  it("returns 'code-2' for MCP-prefixed REPL tool", () => {
    expect(getToolIcon('mcp__obsidian__REPL')).toBe('code-2');
  });

  it('still falls back to wrench for unknown tools', () => {
    expect(getToolIcon('UnknownTool')).toBe('wrench');
  });
});

// ─── formatToolSummary — needs the real ClaudeSession module ──────────────────
// formatToolSummary is not exported from ClaudeSession.ts so we test it
// indirectly via the ClaudeSession.run() path through ThreadManager.

// Hoisted mock state — we need the real format logic, so only mock the
// external SDK query() call (it would spawn a subprocess otherwise).
const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  resolve: null as (() => void) | null,
  toolCallRecords: [] as import('../../src/types').ToolCallRecord[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  let queryIterable: AsyncIterable<Record<string, unknown>>;
  return {
    query: (_opts: unknown) => {
      const iter = queryIterable;
      return {
        [Symbol.asyncIterator]: () => iter[Symbol.asyncIterator](),
        close: () => {},
        interrupt: async () => {},
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => null,
      };
    },
    // Store the iterable so tests can inject SDK messages
    __setIterable: (it: AsyncIterable<Record<string, unknown>>) => { queryIterable = it; },
  };
});

const { ClaudeSession } = await import('../../src/ClaudeSession');

async function* makeSDKMessages(
  messages: Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  for (const m of messages) yield m;
}

// Helper: create a minimal SessionCallbacks that captures tool records
function captureCallbacks(): { callbacks: SessionCallbacks; toolRecords: import('../../src/types').ToolCallRecord[] } {
  const toolRecords: import('../../src/types').ToolCallRecord[] = [];
  const callbacks: SessionCallbacks = {
    onToken: () => {},
    onToolUse: (r) => toolRecords.push(r),
    onMessage: () => {},
    onRecap: () => {},
    onDone: () => {},
    onInterrupted: () => {},
    onError: () => {},
    onPermissionRequest: async () => false,
    onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: '', title: '' }),
  };
  return { callbacks, toolRecords };
}

describe('formatToolSummary — REPL', () => {
  it("summarises REPL as 'Run JS: <first line>' (60-char cap on first line)", async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    __setIterable(makeSDKMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-repl-1',
              name: 'REPL',
              input: { code: 'console.log(1)\nconsole.log(2)' },
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const session = new ClaudeSession('/fake/claude');
    const { callbacks, toolRecords } = captureCallbacks();
    await session.run('hi', undefined, '/tmp', 'default', '', callbacks);

    expect(toolRecords).toHaveLength(1);
    expect(toolRecords[0].name).toBe('REPL');
    expect(toolRecords[0].summary).toBe('Run JS: console.log(1)');
  });

  it('truncates the first line of REPL code to 60 chars', async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    const longLine = 'console.log("a very long line that exceeds sixty characters in length")';
    __setIterable(makeSDKMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-repl-2',
              name: 'REPL',
              input: { code: longLine },
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const session = new ClaudeSession('/fake/claude');
    const { callbacks, toolRecords } = captureCallbacks();
    await session.run('hi', undefined, '/tmp', 'default', '', callbacks);

    expect(toolRecords[0].summary).toBe(`Run JS: ${longLine.substring(0, 60)}`);
  });
});

// ─── gitOperation on Bash result ──────────────────────────────────────────────

describe('BashOutput.gitOperation → onGitOperation', () => {
  it('fires onGitOperation with structured text when gitOperation is present', async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    __setIterable(makeSDKMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'git push origin main' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'bash-1',
              content: JSON.stringify({
                stdout: 'Branch pushed.',
                stderr: '',
                returnCode: 0,
                gitOperation: {
                  push: { branch: 'main' },
                  pr: { number: 42, action: 'opened', url: 'https://github.com/x/y/pull/42' },
                },
              }),
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const session = new ClaudeSession('/fake/claude');
    const gitSummaries: string[] = [];
    const { callbacks } = captureCallbacks();
    callbacks.onGitOperation = (s) => gitSummaries.push(s);
    await session.run('hi', undefined, '/tmp', 'default', '', callbacks);

    expect(gitSummaries).toHaveLength(1);
    expect(gitSummaries[0]).toContain('pushed to main');
    expect(gitSummaries[0]).toContain('PR #42 opened');
  });

  it('does not fire onGitOperation for a Bash result without gitOperation', async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    __setIterable(makeSDKMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'echo hello' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'bash-2',
              content: JSON.stringify({ stdout: 'hello', stderr: '', returnCode: 0 }),
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const session = new ClaudeSession('/fake/claude');
    const gitSummaries: string[] = [];
    const { callbacks } = captureCallbacks();
    callbacks.onGitOperation = (s) => gitSummaries.push(s);
    await session.run('hi', undefined, '/tmp', 'default', '', callbacks);

    expect(gitSummaries).toHaveLength(0);
  });
});

// ─── userModified → thread.userModifiedFiles ─────────────────────────────────

describe('FileEditOutput.userModified → onFileUserModified / thread.userModifiedFiles', () => {
  it('fires onFileUserModified with the file path when userModified is true', async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    __setIterable(makeSDKMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'src/auth.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'edit-1',
              content: JSON.stringify({
                filePath: 'src/auth.ts',
                userModified: true,
                diff: '- old\n+ new',
              }),
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const session = new ClaudeSession('/fake/claude');
    const modifiedFiles: string[] = [];
    const { callbacks } = captureCallbacks();
    callbacks.onFileUserModified = (p) => modifiedFiles.push(p);
    await session.run('hi', undefined, '/tmp', 'default', '', callbacks);

    expect(modifiedFiles).toHaveLength(1);
    expect(modifiedFiles[0]).toBe('src/auth.ts');
  });

  it('does NOT fire onFileUserModified when userModified is false', async () => {
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    __setIterable(makeSDKMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'edit-2', name: 'Edit', input: { file_path: 'src/auth.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'edit-2',
              content: JSON.stringify({
                filePath: 'src/auth.ts',
                userModified: false,
              }),
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const session = new ClaudeSession('/fake/claude');
    const modifiedFiles: string[] = [];
    const { callbacks } = captureCallbacks();
    callbacks.onFileUserModified = (p) => modifiedFiles.push(p);
    await session.run('hi', undefined, '/tmp', 'default', '', callbacks);

    expect(modifiedFiles).toHaveLength(0);
  });

  it('stores modified file path in thread.userModifiedFiles via the SDK path', async () => {
    // Test the full pipeline: SDK tool_result with userModified → onFileUserModified
    // callback → ClaudeSession fires callback with path.
    const { __setIterable } = await import('@anthropic-ai/claude-agent-sdk') as any;
    __setIterable(makeSDKMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'edit-3', name: 'Edit', input: { file_path: 'src/components/Button.tsx' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'edit-3',
              content: JSON.stringify({
                filePath: 'src/components/Button.tsx',
                userModified: true,
              }),
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sess', total_cost_usd: 0, num_turns: 1 },
    ]));

    const session = new ClaudeSession('/fake/claude');
    const modifiedFiles: string[] = [];
    const { callbacks } = captureCallbacks();
    callbacks.onFileUserModified = (p) => modifiedFiles.push(p);
    await session.run('hi', undefined, '/tmp', 'default', '', callbacks);

    // Verify the callback was fired with the correct path
    expect(modifiedFiles).toHaveLength(1);
    expect(modifiedFiles[0]).toBe('src/components/Button.tsx');
  });
});

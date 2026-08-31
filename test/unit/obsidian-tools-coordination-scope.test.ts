import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';

const app = { plugins: { plugins: {} }, workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() }, vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] }, metadataCache: { on: () => {} } } as unknown as App;

describe('coordination tool scoping', () => {
  it('passes explicit elevation to list and direct-target authorization', async () => {
    const authorizeThread = vi.fn().mockReturnValue(false);
    const server = createClaudeThreadsMcpServers(app, {
      getAllThreads: () => [{ id: 'a', title: 'A', projectId: 'project-a' } as never],
      getThreadDetail: () => ({ id: 'a', title: 'A', projectId: 'project-a', messages: [] } as never),
      authorizeThread,
    }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> };

    const list = server.tools.find(tool => tool.name === 'threads_list')!;
    const listed = await list.handler({ projectId: 'project-a' });
    expect(authorizeThread).toHaveBeenCalledWith('a', 'project-a', 'read');
    expect(JSON.parse(listed.content[0]!.text)).toEqual([]);

    const messages = server.tools.find(tool => tool.name === 'threads_get_messages')!;
    const denied = await messages.handler({ threadId: 'a', elevatedProjectId: 'project-a' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain('outside coordination scope');
  });

  it('requires authorization for both reassignment source and destination', async () => {
    const authorizeThread = vi.fn().mockReturnValue(true);
    const authorizeProjectDestination = vi.fn().mockReturnValue(false);
    const setThreadProject = vi.fn();
    const server = createClaudeThreadsMcpServers(app, { authorizeThread, authorizeProjectDestination, setThreadProject }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> };
    const tool = server.tools.find(candidate => candidate.name === 'threads_set_project')!;

    const denied = await tool.handler({ threadId: 'worker-a', projectId: 'project-b', elevatedProjectId: 'project-a' });

    expect(authorizeThread).toHaveBeenCalledWith('worker-a', 'project-a', 'write');
    expect(authorizeProjectDestination).toHaveBeenCalledWith('project-b', 'project-a');
    expect(denied.isError).toBe(true);
    expect(setThreadProject).not.toHaveBeenCalled();
  });

  it('enforces the central boundary across every direct coordination tool', async () => {
    const authorizeThread = vi.fn().mockReturnValue(false);
    const server = createClaudeThreadsMcpServers(app, {
      threadId: 'caller', authorizeThread,
      getThreadDetail: () => ({ id: 'target', title: 'Target', messages: [] } as never),
      readThreadLog: vi.fn(), isThreadRunning: vi.fn(), sendMessageToThread: vi.fn(), archiveThread: vi.fn(),
      setThreadProject: vi.fn(), setThreadNotes: vi.fn(), setThreadProposedReply: vi.fn(), clearThreadProposedReply: vi.fn(),
    }).claude_threads as unknown as { tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> }> };
    const cases = [
      ['threads_get_messages', { threadId: 'target' }], ['threads_get_log', { threadId: 'target' }],
      ['threads_wait', { threadId: 'target' }], ['threads_send_message', { threadId: 'target', message: 'hi' }],
      ['threads_archive', { threadId: 'target' }], ['threads_set_project', { threadId: 'target', projectId: null }],
      ['threads_set_notes', { threadId: 'target', notes: 'n' }], ['threads_set_proposed_reply', { threadId: 'target', text: 'r' }],
      ['threads_clear_proposed_reply', { threadId: 'target' }],
    ] as const;
    for (const [name, args] of cases) {
      const result = await server.tools.find(tool => tool.name === name)!.handler(args);
      expect(result.isError, name).toBe(true);
    }
    expect(authorizeThread).toHaveBeenCalledTimes(cases.length);
  });
});

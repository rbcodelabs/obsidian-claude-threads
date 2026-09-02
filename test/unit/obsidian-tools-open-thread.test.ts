import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers } from '../../src/ObsidianTools';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

type ToolDefinition = {
  name: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

function tools(options: Parameters<typeof createClaudeThreadsMcpServers>[1] = {}) {
  const servers = createClaudeThreadsMcpServers(app, options);
  return {
    canonical: (servers.claude_threads as unknown as { tools: ToolDefinition[]; harnessTools: Array<{ name: string; requiresApproval: boolean }> }),
    legacy: (servers.obsidian as unknown as { tools: ToolDefinition[] }),
  };
}

describe('threads_open', () => {
  it('exposes one shared canonical and compatibility contract and requires native approval', () => {
    const { canonical, legacy } = tools();
    const current = canonical.tools.find(tool => tool.name === 'threads_open')!;
    const compatibility = legacy.tools.find(tool => tool.name === 'obsidian_open_thread')!;

    expect(current).toBeDefined();
    expect(compatibility).toBeDefined();
    expect(current.inputSchema).toBe(compatibility.inputSchema);
    expect(current.handler).toBe(compatibility.handler);
    expect(z.object(current.inputSchema).safeParse({}).success).toBe(false);
    expect(z.object(current.inputSchema).safeParse({ threadId: 'opaque/uuid:42', elevatedProjectId: 'project-a' }).success).toBe(true);
    expect(canonical.harnessTools.find(tool => tool.name === 'threads_open')).toMatchObject({ requiresApproval: true });
  });

  it('authorizes read access before inspecting or opening the exact target', async () => {
    const authorizeThread = vi.fn().mockReturnValue(false);
    const getThreadDetail = vi.fn();
    const openThread = vi.fn();
    const { canonical } = tools({ authorizeThread, getThreadDetail, openThread });

    const result = await canonical.tools.find(tool => tool.name === 'threads_open')!.handler({
      threadId: 'opaque/uuid:42',
      elevatedProjectId: 'project-a',
    });

    expect(authorizeThread).toHaveBeenCalledWith('opaque/uuid:42', 'project-a', 'read');
    expect(getThreadDetail).not.toHaveBeenCalled();
    expect(openThread).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Target is outside coordination scope.');
  });

  it('returns not found for an authorized missing target without opening it', async () => {
    const openThread = vi.fn();
    const { canonical } = tools({
      authorizeThread: vi.fn().mockReturnValue(true),
      getThreadDetail: vi.fn().mockReturnValue(undefined),
      openThread,
    });

    const result = await canonical.tools.find(tool => tool.name === 'threads_open')!.handler({ threadId: 'missing' });

    expect(openThread).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Thread not found: missing');
  });

  it('reports an unavailable host capability without authorizing or inspecting a target', async () => {
    const authorizeThread = vi.fn();
    const getThreadDetail = vi.fn();
    const { canonical } = tools({ authorizeThread, getThreadDetail });

    const result = await canonical.tools.find(tool => tool.name === 'threads_open')!.handler({ threadId: 'target' });

    expect(authorizeThread).not.toHaveBeenCalled();
    expect(getThreadDetail).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Thread navigation is not available in this context.');
  });

  it('forwards the exact opaque ID and resolves success only after navigation completes', async () => {
    let release!: () => void;
    const navigation = new Promise<void>(resolve => { release = resolve; });
    const openThread = vi.fn(() => navigation);
    const { canonical } = tools({
      authorizeThread: vi.fn().mockReturnValue(true),
      getThreadDetail: vi.fn().mockReturnValue({ id: 'opaque/uuid:42', title: 'Target', messages: [] }),
      openThread,
    });

    let settled = false;
    const pending = canonical.tools.find(tool => tool.name === 'threads_open')!
      .handler({ threadId: 'opaque/uuid:42' })
      .then(result => { settled = true; return result; });
    await Promise.resolve();

    expect(openThread).toHaveBeenCalledWith('opaque/uuid:42');
    expect(settled).toBe(false);
    release();
    const result = await pending;
    expect(JSON.parse(result.content[0]!.text)).toEqual({ success: true, threadId: 'opaque/uuid:42' });
  });
});

/**
 * obsidian-tools-archive-thread.test.ts
 *
 * Unit tests for the obsidian_archive_thread MCP tool defined in ObsidianTools.ts.
 *
 * Strategy: mock @anthropic-ai/claude-agent-sdk/browser so we can capture each
 * tool's handler function and invoke it directly, without needing a real Obsidian
 * environment or a running MCP server.
 */

import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ) => ({ _toolName: name, _handler: handler }),

  createSdkMcpServer: ({ tools }: { tools: CapturedTool[] }) => ({ tools }),
}));

import { createObsidianMcpServer } from '../../src/ObsidianTools';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolResult {
  content: [{ type: string; text: string }];
  isError?: boolean;
}

interface CapturedTool {
  _toolName: string;
  _handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
}

interface CapturedServer {
  tools: CapturedTool[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(): App {
  return {
    plugins: { plugins: {} },
    workspace: {
      getLeavesOfType: () => [],
      onLayoutReady: (cb: () => void) => cb(),
    },
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { on: () => {} },
  } as unknown as App;
}

function getTool(server: CapturedServer, name: string): CapturedTool {
  const t = server.tools.find((tool) => tool._toolName === name);
  if (!t) throw new Error(`Tool "${name}" not found in server`);
  return t;
}

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

// ── obsidian_archive_thread ───────────────────────────────────────────────────

describe('obsidian_archive_thread', () => {
  it('is registered in the server tool list', () => {
    const server = createObsidianMcpServer(makeApp()) as unknown as CapturedServer;
    expect(() => getTool(server, 'obsidian_archive_thread')).not.toThrow();
  });

  it('returns an error when archiveThread option is not provided', async () => {
    const server = createObsidianMcpServer(makeApp()) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_archive_thread');

    const result = await tool._handler({ threadId: 'abc' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/not available/i);
  });

  it('returns an error when trying to archive the current thread', async () => {
    const archiveThread = vi.fn();
    const server = createObsidianMcpServer(makeApp(), {
      threadId: 'current-thread',
      archiveThread,
    }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_archive_thread');

    const result = await tool._handler({ threadId: 'current-thread' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/current thread/i);
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it('defers archiving when the current thread has a scheduled origin', async () => {
    const archiveThread = vi.fn();
    const requestDeferredArchive = vi.fn();
    const server = createObsidianMcpServer(makeApp(), {
      threadId: 'current-thread',
      archiveThread,
      requestDeferredArchive,
      getThreadDetail: () => ({ scheduledItemId: 'scheduled-item' } as never),
    }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_archive_thread');

    const result = await tool._handler({ threadId: 'current-thread' });

    expect(result.isError).toBeUndefined();
    expect(requestDeferredArchive).toHaveBeenCalledWith('current-thread');
    expect(archiveThread).not.toHaveBeenCalled();
    expect(parseResult(result)).toEqual({
      success: true,
      archivedThreadId: 'current-thread',
      deferred: true,
    });
  });

  it('calls archiveThread and returns success for a different thread', async () => {
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const server = createObsidianMcpServer(makeApp(), {
      threadId: 'current-thread',
      archiveThread,
    }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_archive_thread');

    const result = await tool._handler({ threadId: 'other-thread' });

    expect(result.isError).toBeUndefined();
    expect(archiveThread).toHaveBeenCalledOnce();
    expect(archiveThread).toHaveBeenCalledWith('other-thread');
    const payload = parseResult(result) as { success: boolean; archivedThreadId: string };
    expect(payload.success).toBe(true);
    expect(payload.archivedThreadId).toBe('other-thread');
  });

  it('works when no current threadId is set (can archive any thread)', async () => {
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const server = createObsidianMcpServer(makeApp(), { archiveThread }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_archive_thread');

    const result = await tool._handler({ threadId: 'some-thread' });

    expect(result.isError).toBeUndefined();
    expect(archiveThread).toHaveBeenCalledWith('some-thread');
  });

  it('returns an error (not a throw) when archiveThread rejects', async () => {
    const archiveThread = vi.fn().mockRejectedValue(new Error('Thread not found: missing-id'));
    const server = createObsidianMcpServer(makeApp(), {
      threadId: 'current-thread',
      archiveThread,
    }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_archive_thread');

    const result = await tool._handler({ threadId: 'missing-id' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/Thread not found/);
  });

  describe('orchestrator thread confirm guard', () => {
    it('still requires confirmation when a scheduled current thread is the orchestrator', async () => {
      const archiveThread = vi.fn();
      const requestDeferredArchive = vi.fn();
      const server = createObsidianMcpServer(makeApp(), {
        threadId: 'orchestrator-thread',
        archiveThread,
        requestDeferredArchive,
        getThreadDetail: () => ({ scheduledItemId: 'scheduled-item' } as never),
        getOrchestratorThreadId: () => 'orchestrator-thread',
      }) as unknown as CapturedServer;
      const tool = getTool(server, 'obsidian_archive_thread');

      const result = await tool._handler({ threadId: 'orchestrator-thread' });

      expect(result.isError).toBe(true);
      expect((parseResult(result) as { error: string }).error).toMatch(/Thread Orchestrator/);
      expect(requestDeferredArchive).not.toHaveBeenCalled();
    });

    it('returns an error and does not archive the orchestrator thread when confirm is omitted', async () => {
      const archiveThread = vi.fn().mockResolvedValue(undefined);
      const server = createObsidianMcpServer(makeApp(), {
        threadId: 'current-thread',
        archiveThread,
        getOrchestratorThreadId: () => 'orchestrator-thread',
      }) as unknown as CapturedServer;
      const tool = getTool(server, 'obsidian_archive_thread');

      const result = await tool._handler({ threadId: 'orchestrator-thread' });

      expect(result.isError).toBe(true);
      expect((parseResult(result) as { error: string }).error).toMatch(/Thread Orchestrator/);
      expect(archiveThread).not.toHaveBeenCalled();
    });

    it('returns an error when confirm is explicitly false', async () => {
      const archiveThread = vi.fn().mockResolvedValue(undefined);
      const server = createObsidianMcpServer(makeApp(), {
        threadId: 'current-thread',
        archiveThread,
        getOrchestratorThreadId: () => 'orchestrator-thread',
      }) as unknown as CapturedServer;
      const tool = getTool(server, 'obsidian_archive_thread');

      const result = await tool._handler({ threadId: 'orchestrator-thread', confirm: false });

      expect(result.isError).toBe(true);
      expect(archiveThread).not.toHaveBeenCalled();
    });

    it('archives the orchestrator thread when confirm is true', async () => {
      const archiveThread = vi.fn().mockResolvedValue(undefined);
      const server = createObsidianMcpServer(makeApp(), {
        threadId: 'current-thread',
        archiveThread,
        getOrchestratorThreadId: () => 'orchestrator-thread',
      }) as unknown as CapturedServer;
      const tool = getTool(server, 'obsidian_archive_thread');

      const result = await tool._handler({ threadId: 'orchestrator-thread', confirm: true });

      expect(result.isError).toBeUndefined();
      expect(archiveThread).toHaveBeenCalledWith('orchestrator-thread');
      const payload = parseResult(result) as { success: boolean; archivedThreadId: string };
      expect(payload.success).toBe(true);
      expect(payload.archivedThreadId).toBe('orchestrator-thread');
    });

    it('archives a non-orchestrator thread without confirm needed (unchanged behavior)', async () => {
      const archiveThread = vi.fn().mockResolvedValue(undefined);
      const server = createObsidianMcpServer(makeApp(), {
        threadId: 'current-thread',
        archiveThread,
        getOrchestratorThreadId: () => 'orchestrator-thread',
      }) as unknown as CapturedServer;
      const tool = getTool(server, 'obsidian_archive_thread');

      const result = await tool._handler({ threadId: 'some-other-thread' });

      expect(result.isError).toBeUndefined();
      expect(archiveThread).toHaveBeenCalledWith('some-other-thread');
    });

    it('does not require confirm when getOrchestratorThreadId is not provided', async () => {
      const archiveThread = vi.fn().mockResolvedValue(undefined);
      const server = createObsidianMcpServer(makeApp(), {
        threadId: 'current-thread',
        archiveThread,
      }) as unknown as CapturedServer;
      const tool = getTool(server, 'obsidian_archive_thread');

      const result = await tool._handler({ threadId: 'any-thread' });

      expect(result.isError).toBeUndefined();
      expect(archiveThread).toHaveBeenCalledWith('any-thread');
    });
  });
});

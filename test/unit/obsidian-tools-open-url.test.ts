/**
 * obsidian-tools-open-url.test.ts
 *
 * Unit tests for the obsidian_open_url MCP tool defined in ObsidianTools.ts.
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

function makeLeaf(overrides: Partial<{ setViewState: () => Promise<void> }> = {}) {
  return {
    setViewState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeApp(opts: {
  existingLeaves?: object[];
  newLeaf?: object;
} = {}): App {
  const existingLeaves = opts.existingLeaves ?? [];
  const newLeaf = opts.newLeaf ?? makeLeaf();

  return {
    plugins: { plugins: {} },
    workspace: {
      getLeavesOfType: vi.fn().mockReturnValue(existingLeaves),
      getLeaf: vi.fn().mockReturnValue(newLeaf),
      revealLeaf: vi.fn(),
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

// ── obsidian_open_url ─────────────────────────────────────────────────────────

describe('obsidian_open_url', () => {
  it('is registered in the server tool list', () => {
    const server = createObsidianMcpServer(makeApp()) as unknown as CapturedServer;
    expect(() => getTool(server, 'obsidian_open_url')).not.toThrow();
  });

  it('reuses an existing webviewer tab when one is open', async () => {
    const existingLeaf = makeLeaf();
    const app = makeApp({ existingLeaves: [existingLeaf] });
    const server = createObsidianMcpServer(app) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_open_url');

    const result = await tool._handler({ url: 'http://localhost:8765/' });

    expect(result.isError).toBeUndefined();
    // Should NOT have called getLeaf to create a new tab
    expect((app.workspace as unknown as { getLeaf: ReturnType<typeof vi.fn> }).getLeaf).not.toHaveBeenCalled();
    expect(existingLeaf.setViewState).toHaveBeenCalledWith({
      type: 'webviewer',
      active: true,
      state: { url: 'http://localhost:8765/' },
    });
    const payload = parseResult(result) as { success: boolean; url: string; reusedTab: boolean };
    expect(payload.success).toBe(true);
    expect(payload.reusedTab).toBe(true);
    expect(payload.url).toBe('http://localhost:8765/');
  });

  it('opens a new tab when no webviewer leaf exists', async () => {
    const newLeaf = makeLeaf();
    const app = makeApp({ existingLeaves: [], newLeaf });
    const server = createObsidianMcpServer(app) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_open_url');

    const result = await tool._handler({ url: 'http://localhost:8765/sample.html' });

    expect(result.isError).toBeUndefined();
    expect((app.workspace as unknown as { getLeaf: ReturnType<typeof vi.fn> }).getLeaf).toHaveBeenCalledWith('tab');
    expect(newLeaf.setViewState).toHaveBeenCalledWith({
      type: 'webviewer',
      active: true,
      state: { url: 'http://localhost:8765/sample.html' },
    });
    const payload = parseResult(result) as { success: boolean; reusedTab: boolean };
    expect(payload.success).toBe(true);
    expect(payload.reusedTab).toBe(false);
  });

  it('forces a new tab when newTab is true, even if a webviewer tab is already open', async () => {
    const existingLeaf = makeLeaf();
    const newLeaf = makeLeaf();
    const app = makeApp({ existingLeaves: [existingLeaf], newLeaf });
    const server = createObsidianMcpServer(app) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_open_url');

    const result = await tool._handler({ url: 'http://localhost:9000/', newTab: true });

    expect(result.isError).toBeUndefined();
    // Existing leaf must NOT be used
    expect(existingLeaf.setViewState).not.toHaveBeenCalled();
    expect((app.workspace as unknown as { getLeaf: ReturnType<typeof vi.fn> }).getLeaf).toHaveBeenCalledWith('tab');
    expect(newLeaf.setViewState).toHaveBeenCalled();
    const payload = parseResult(result) as { reusedTab: boolean };
    expect(payload.reusedTab).toBe(false);
  });

  it('reveals the leaf so the Web Viewer panel becomes visible', async () => {
    const existingLeaf = makeLeaf();
    const app = makeApp({ existingLeaves: [existingLeaf] });
    const server = createObsidianMcpServer(app) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_open_url');

    await tool._handler({ url: 'http://localhost:8765/' });

    expect((app.workspace as unknown as { revealLeaf: ReturnType<typeof vi.fn> }).revealLeaf)
      .toHaveBeenCalledWith(existingLeaf);
  });

  it('returns isError (not a throw) when setViewState rejects', async () => {
    const badLeaf = makeLeaf({
      setViewState: vi.fn().mockRejectedValue(new Error('webviewer not available')),
    });
    const app = makeApp({ existingLeaves: [badLeaf] });
    const server = createObsidianMcpServer(app) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_open_url');

    const result = await tool._handler({ url: 'http://localhost:8765/' });

    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/webviewer not available/);
  });
});

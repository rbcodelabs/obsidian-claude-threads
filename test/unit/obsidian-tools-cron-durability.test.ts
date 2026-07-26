/**
 * obsidian-tools-cron-durability.test.ts
 *
 * Regression coverage for the cron-persistence race: the CronCreate/CronUpdate/
 * CronDelete MCP tool handlers in ObsidianTools.ts used to call
 * onCronCreate/onCronUpdate/onCronDelete without awaiting them, so the tool
 * could report success back to the caller before the underlying Scheduler
 * mutation's disk write had landed. These tests confirm the handlers now
 * await the callback and only build their response after it resolves.
 *
 * Strategy mirrors obsidian-tools-archive-thread.test.ts: mock
 * @anthropic-ai/claude-agent-sdk/browser so we can capture each tool's handler
 * function and invoke it directly.
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

const sampleItem = {
  id: 'item-1',
  name: 'Nightly digest',
  prompt: 'send the digest',
  schedule: { type: 'interval' as const, intervalSeconds: 3600 },
  enabled: true,
};

describe('CronCreate durability', () => {
  it('does not resolve until onCronCreate resolves', async () => {
    let resolveCreate: (() => void) | undefined;
    const onCronCreate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = () => resolve(sampleItem);
        }),
    );
    const server = createObsidianMcpServer(makeApp(), { onCronCreate }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronCreate');

    let resolved = false;
    const promise = tool
      ._handler({ name: 'Nightly digest', prompt: 'send the digest', scheduleType: 'interval', intervalSeconds: 3600 })
      .then((r) => {
        resolved = true;
        return r;
      });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveCreate!();
    const result = await promise;

    expect(resolved).toBe(true);
    expect(result.isError).toBeUndefined();
  });
});

describe('CronUpdate durability', () => {
  it('does not resolve until onCronUpdate resolves', async () => {
    let resolveUpdate: (() => void) | undefined;
    const onCronUpdate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = () => resolve({ ...sampleItem, enabled: false });
        }),
    );
    const server = createObsidianMcpServer(makeApp(), { onCronUpdate }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronUpdate');

    let resolved = false;
    const promise = tool._handler({ id: 'item-1', enabled: false }).then((r) => {
      resolved = true;
      return r;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(onCronUpdate).toHaveBeenCalledWith('item-1', { enabled: false });

    resolveUpdate!();
    const result = await promise;

    expect(resolved).toBe(true);
    expect(result.isError).toBeUndefined();
  });
});

describe('CronDelete durability', () => {
  it('does not resolve until onCronDelete resolves', async () => {
    let resolveDelete: (() => void) | undefined;
    const onCronDelete = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const server = createObsidianMcpServer(makeApp(), { onCronDelete }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronDelete');

    let resolved = false;
    const promise = tool._handler({ id: 'item-1' }).then((r) => {
      resolved = true;
      return r;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(onCronDelete).toHaveBeenCalledWith('item-1');

    resolveDelete!();
    const result = await promise;

    expect(resolved).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it('returns an error (not a throw) when onCronDelete rejects', async () => {
    const onCronDelete = vi.fn().mockRejectedValue(new Error('disk full'));
    const server = createObsidianMcpServer(makeApp(), { onCronDelete }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronDelete');

    const result = await tool._handler({ id: 'item-1' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/disk full/);
  });
});

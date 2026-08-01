/**
 * obsidian-tools-schedulewakeup-durability.test.ts
 *
 * Regression coverage for the ScheduleWakeup reliability fix: the tool
 * handler used to call options.onScheduleWakeup(...) without awaiting it, so
 * (once onScheduleWakeup was switched to create a durable Scheduler item
 * instead of a bare window.setTimeout — see main.ts) the tool could report
 * "Wakeup scheduled" back to the caller before the underlying disk write had
 * actually landed. Mirrors obsidian-tools-cron-durability.test.ts exactly,
 * for the same reason: a tool response that arrives before persistence is
 * confirmed is a reliability bug, not just a cosmetic one.
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

describe('ScheduleWakeup durability', () => {
  it('does not resolve "Wakeup scheduled" until onScheduleWakeup (disk persistence) resolves', async () => {
    let resolveSchedule: (() => void) | undefined;
    const onScheduleWakeup = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSchedule = resolve;
        }),
    );
    const server = createObsidianMcpServer(makeApp(), { onScheduleWakeup }) as unknown as CapturedServer;
    const tool = getTool(server, 'ScheduleWakeup');

    let resolved = false;
    const promise = tool
      ._handler({ delaySeconds: 300, prompt: '/loop check-deploy', reason: 'checking deploy status' })
      .then((r) => {
        resolved = true;
        return r;
      });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(onScheduleWakeup).toHaveBeenCalledWith(300_000, '/loop check-deploy', 'checking deploy status');

    resolveSchedule!();
    const result = await promise;

    expect(resolved).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Wakeup scheduled in 300s/);
  });

  it('returns an error (not a throw) when onScheduleWakeup rejects', async () => {
    const onScheduleWakeup = vi.fn().mockRejectedValue(new Error('disk full'));
    const server = createObsidianMcpServer(makeApp(), { onScheduleWakeup }) as unknown as CapturedServer;
    const tool = getTool(server, 'ScheduleWakeup');

    const result = await tool._handler({ delaySeconds: 60, prompt: 'x', reason: 'y' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disk full/);
  });
});

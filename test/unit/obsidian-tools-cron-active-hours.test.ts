/**
 * obsidian-tools-cron-active-hours.test.ts
 *
 * Coverage for the activeHours params on the CronCreate/CronUpdate MCP tools
 * (src/ObsidianTools.ts). These let an agent scope a scheduled item to a
 * local-time window (e.g. "07:00"-"22:00") without encoding a business-hours
 * check into the prompt itself — see scheduler-active-hours.test.ts for the
 * Scheduler-side gating this feeds.
 *
 * Strategy mirrors obsidian-tools-cron-durability.test.ts: mock
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

const sampleItem = {
  id: 'item-1',
  name: 'Jarvis Gmail Triage',
  prompt: 'run triage',
  schedule: { type: 'interval' as const, intervalSeconds: 21600 },
  enabled: true,
};

describe('CronCreate activeHours', () => {
  it('builds schedule.activeHours when both start and end are given', async () => {
    const onCronCreate = vi.fn().mockResolvedValue(sampleItem);
    const server = createObsidianMcpServer(makeApp(), { onCronCreate }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronCreate');

    const result = await tool._handler({
      name: 'Jarvis Gmail Triage',
      prompt: 'run triage',
      scheduleType: 'interval',
      intervalSeconds: 21600,
      activeHoursStart: '07:00',
      activeHoursEnd: '22:00',
    });

    expect(result.isError).toBeUndefined();
    expect(onCronCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: expect.objectContaining({ activeHours: { start: '07:00', end: '22:00' } }),
      }),
    );
  });

  it('omits activeHours when neither start nor end is given', async () => {
    const onCronCreate = vi.fn().mockResolvedValue(sampleItem);
    const server = createObsidianMcpServer(makeApp(), { onCronCreate }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronCreate');

    await tool._handler({ name: 'x', prompt: 'y', scheduleType: 'interval', intervalSeconds: 60 });

    expect(onCronCreate).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: expect.objectContaining({ activeHours: undefined }) }),
    );
  });

  it('errors when only one of activeHoursStart/activeHoursEnd is given', async () => {
    const onCronCreate = vi.fn().mockResolvedValue(sampleItem);
    const server = createObsidianMcpServer(makeApp(), { onCronCreate }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronCreate');

    const result = await tool._handler({
      name: 'x',
      prompt: 'y',
      scheduleType: 'interval',
      intervalSeconds: 60,
      activeHoursStart: '07:00',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/must both be provided together/);
    expect(onCronCreate).not.toHaveBeenCalled();
  });
});

describe('CronUpdate activeHours', () => {
  it('sets schedule.activeHours when both start and end are given', async () => {
    const onCronUpdate = vi.fn().mockResolvedValue({ ...sampleItem, schedule: { ...sampleItem.schedule, activeHours: { start: '07:00', end: '22:00' } } });
    const server = createObsidianMcpServer(makeApp(), { onCronUpdate }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronUpdate');

    const result = await tool._handler({ id: 'item-1', activeHoursStart: '07:00', activeHoursEnd: '22:00' });

    expect(result.isError).toBeUndefined();
    expect(onCronUpdate).toHaveBeenCalledWith('item-1', { schedule: { activeHours: { start: '07:00', end: '22:00' } } });
  });

  it('merges a partial update (only start) with the existing window via onCronList', async () => {
    const onCronList = vi.fn().mockReturnValue([
      { ...sampleItem, schedule: { ...sampleItem.schedule, activeHours: { start: '07:00', end: '22:00' } } },
    ]);
    const onCronUpdate = vi.fn().mockResolvedValue(sampleItem);
    const server = createObsidianMcpServer(makeApp(), { onCronUpdate, onCronList }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronUpdate');

    await tool._handler({ id: 'item-1', activeHoursStart: '08:00' });

    expect(onCronUpdate).toHaveBeenCalledWith('item-1', { schedule: { activeHours: { start: '08:00', end: '22:00' } } });
  });

  it('errors on a partial update when there is no existing window to merge with', async () => {
    const onCronList = vi.fn().mockReturnValue([sampleItem]); // no activeHours on the existing item
    const onCronUpdate = vi.fn().mockResolvedValue(sampleItem);
    const server = createObsidianMcpServer(makeApp(), { onCronUpdate, onCronList }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronUpdate');

    const result = await tool._handler({ id: 'item-1', activeHoursStart: '08:00' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/no existing active-hours window/);
    expect(onCronUpdate).not.toHaveBeenCalled();
  });

  it('clearActiveHours removes the window entirely', async () => {
    const onCronUpdate = vi.fn().mockResolvedValue(sampleItem);
    const server = createObsidianMcpServer(makeApp(), { onCronUpdate }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronUpdate');

    await tool._handler({ id: 'item-1', clearActiveHours: true });

    expect(onCronUpdate).toHaveBeenCalledWith('item-1', { schedule: { activeHours: undefined } });
  });

  it('a plain enabled toggle is unaffected (no schedule patch built)', async () => {
    const onCronUpdate = vi.fn().mockResolvedValue({ ...sampleItem, enabled: false });
    const server = createObsidianMcpServer(makeApp(), { onCronUpdate }) as unknown as CapturedServer;
    const tool = getTool(server, 'CronUpdate');

    await tool._handler({ id: 'item-1', enabled: false });

    expect(onCronUpdate).toHaveBeenCalledWith('item-1', { enabled: false });
  });
});

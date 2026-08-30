/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capturedInputs = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../src/DispatchInput', () => ({
  DispatchInput: class {
    private value = '';
    constructor(options: Record<string, unknown>) { capturedInputs.push(options); }
    mount() {}
    destroy() {}
    setValue(value: string) { this.value = value; }
    getValue() { return this.value; }
  },
}));
vi.mock('../../src/ClaudeSession', () => ({
  formatToolName: (name: string) => name,
  getToolIcon: () => 'wrench',
}));
vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => false }));

import { AgentDashboard } from '../../src/AgentDashboard';
import { KanbanView } from '../../src/KanbanView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

interface DispatchOptions {
  onSend(args: {
    text: string;
    images: unknown[];
    attachment: string | null;
    agentHarness: 'claude' | 'codex';
  }): Promise<void>;
}

function makeFixture() {
  const settings = { ...DEFAULT_SETTINGS, kanbanCollapseSide: 'none' as const };
  const manager = new ThreadManager(settings);
  const app = {
    vault: { getMarkdownFiles: () => [] },
    workspace: {
      leftSplit: { collapsed: true, collapse: vi.fn(), expand: vi.fn() },
      rightSplit: { collapsed: true, collapse: vi.fn(), expand: vi.fn() },
    },
  };
  const plugin = {
    app,
    settings,
    manager,
    getActiveThreadId: () => null,
    getPendingWakeups: () => [],
    hasPendingWakeup: () => false,
    saveSettings: vi.fn(async () => undefined),
    activateKanbanView: vi.fn(),
    openThreadInChatView: vi.fn(async () => undefined),
    dispatchNewThread: vi.fn(async () => 'ordinary-thread'),
    dispatchNewDesignThread: vi.fn(async () => 'design-thread'),
  };
  return { app, manager, plugin };
}

describe.each([
  ['Agent Dashboard', AgentDashboard],
  ['Kanban', KanbanView],
] as const)('%s new-thread design routing', (_label, View) => {
  beforeEach(() => { capturedInputs.length = 0; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses the native design dispatcher and never the ordinary prompt dispatcher', async () => {
    const { app, plugin } = makeFixture();
    const view = new View({} as never, plugin as never);
    (view as unknown as { app: unknown }).app = app;
    await view.onOpen();
    const options = capturedInputs.at(-1) as unknown as DispatchOptions;

    await options.onSend({
      text: '/design create a simple responsive settings card',
      images: [],
      attachment: null,
      agentHarness: 'codex',
    });

    expect(plugin.dispatchNewDesignThread).toHaveBeenCalledWith(
      'create a simple responsive settings card',
      'codex',
    );
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
    await view.onClose();
  });

  it('rejects design attachments instead of silently dropping them', async () => {
    const { app, plugin } = makeFixture();
    const view = new View({} as never, plugin as never);
    (view as unknown as { app: unknown }).app = app;
    await view.onOpen();
    const options = capturedInputs.at(-1) as unknown as DispatchOptions;

    await options.onSend({
      text: '/design settings card',
      images: [{}],
      attachment: null,
      agentHarness: 'claude',
    });

    expect(plugin.dispatchNewDesignThread).not.toHaveBeenCalled();
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
    await view.onClose();
  });
});

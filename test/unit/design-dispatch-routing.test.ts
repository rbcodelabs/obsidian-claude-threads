/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  default: {
    readdirSync: () => [], statSync: () => ({ isDirectory: () => false }),
    existsSync: () => false, readFileSync: () => '',
  },
  readdirSync: () => [], statSync: () => ({ isDirectory: () => false }),
  existsSync: () => false, readFileSync: () => '',
}));
vi.mock('../../src/stt', () => ({
  SttController: function SttController() {
    return {
      attachPttToTextarea: vi.fn(() => () => {}),
      createMicButton: vi.fn(() => document.createElement('button')),
      destroy: vi.fn(),
    };
  },
}));
vi.mock('../../src/ClaudeSession', () => ({
  formatToolName: (name: string) => name,
  getToolIcon: () => 'wrench',
}));
vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => false }));

import { AgentDashboard } from '../../src/AgentDashboard';
import { DispatchInput } from '../../src/DispatchInput';
import { KanbanView } from '../../src/KanbanView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type ImageAttachment } from '../../src/types';

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
  beforeEach(() => { document.body.empty(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function getDispatchInput(view: InstanceType<typeof View>): DispatchInput {
    const internals = view as unknown as {
      dispatchComponent?: DispatchInput;
      dispatchInput?: DispatchInput;
    };
    return internals.dispatchComponent ?? internals.dispatchInput!;
  }

  it('uses the native design dispatcher and never the ordinary prompt dispatcher', async () => {
    const { app, plugin } = makeFixture();
    const view = new View({} as never, plugin as never);
    (view as unknown as { app: unknown }).app = app;
    await view.onOpen();
    const input = getDispatchInput(view);

    input.setValue('/design create a simple responsive settings card');
    input.triggerSend();

    await vi.waitFor(() => expect(plugin.dispatchNewDesignThread).toHaveBeenCalledWith(
      'create a simple responsive settings card', 'claude',
    ));
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
    await view.onClose();
  });

  it('preserves image and text attachments when design dispatch rejects them', async () => {
    const { app, plugin } = makeFixture();
    const view = new View({} as never, plugin as never);
    (view as unknown as { app: unknown }).app = app;
    await view.onOpen();
    const input = getDispatchInput(view);
    const image: ImageAttachment = {
      base64: 'aGVsbG8=', mediaType: 'image/png', name: 'settings.png',
    };

    input.setValue('/design settings card');
    input.setPendingImages([image]);
    input.setPendingAttachment('Reference copy');
    input.triggerSend();

    await vi.waitFor(() => expect(input.getValue()).toBe('/design settings card'));
    expect(input.getPendingImages()).toEqual([image]);
    expect(input.getPendingAttachment()).toBe('Reference copy');
    expect(plugin.dispatchNewDesignThread).not.toHaveBeenCalled();
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
    await view.onClose();
  });

  it('restores a retryable design draft when design setup or navigation fails', async () => {
    const { app, plugin } = makeFixture();
    plugin.dispatchNewDesignThread.mockRejectedValueOnce(new Error('preview unavailable'));
    const view = new View({} as never, plugin as never);
    (view as unknown as { app: unknown }).app = app;
    await view.onOpen();
    const input = getDispatchInput(view);

    input.setValue('/design settings card');
    input.triggerSend();

    await vi.waitFor(() => expect(input.getValue()).toBe('/design settings card'));
    expect(plugin.dispatchNewDesignThread).toHaveBeenCalledOnce();
    expect(plugin.dispatchNewThread).not.toHaveBeenCalled();
    await view.onClose();
  });
});

/**
 * @vitest-environment jsdom
 *
 * Drives the real dashboard and conversation-view recovery event routing.
 */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({
  formatToolName: (name: string) => name,
  getToolIcon: () => 'wrench',
}));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class {} }));
vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => false }));

import { AgentDashboard } from '../../src/AgentDashboard';
import { ThreadsView } from '../../src/ThreadsView';

describe('recovered-thread view routing', () => {
  it('AgentDashboard schedules exactly one render for threads_loaded', () => {
    const view = new AgentDashboard({} as never, { manager: {} } as never) as unknown as {
      handleEvent: (threadId: string, event: { type: string }) => void;
      scheduleRender: () => void;
    };
    const scheduleRender = vi.spyOn(view as never, 'scheduleRender').mockImplementation(() => {});

    view.handleEvent('', { type: 'threads_loaded' });

    expect(scheduleRender).toHaveBeenCalledOnce();
  });

  it.each(['cwd_changed', 'pending_plan_changed', 'plan_ready', 'plan_transition_error'])(
    'AgentDashboard schedules a regroup for %s',
    (type) => {
      const view = new AgentDashboard({} as never, { manager: {} } as never) as unknown as {
        handleEvent: (threadId: string, event: { type: string }) => void;
        scheduleRender: () => void;
      };
      const scheduleRender = vi.spyOn(view as never, 'scheduleRender').mockImplementation(() => {});

      view.handleEvent('thread-a', { type });

      expect(scheduleRender).toHaveBeenCalledOnce();
    },
  );

  it('ThreadsView refreshes project-bar thread counts for threads_loaded', () => {
    const view = new ThreadsView({} as never, { manager: {} } as never) as unknown as {
      handleThreadListEvent: (threadId: string, event: { type: string }) => void;
      renderProjectBar: () => void;
    };
    const renderProjectBar = vi.spyOn(view as never, 'renderProjectBar').mockImplementation(() => {});

    // The emitting thread's id is the first argument — the handler needs it to
    // repair the selection on `thread_deleted` (see threads-view-delete-selection).
    view.handleThreadListEvent('t1', { type: 'threads_loaded' });

    expect(renderProjectBar).toHaveBeenCalledOnce();
  });

  it('keeps settings-selected B when Geode calls setState with stale valid A after onOpen', async () => {
    const itemViewPrototype = Object.getPrototypeOf(ThreadsView.prototype) as { setState?: () => Promise<void> };
    const priorSetState = itemViewPrototype.setState;
    itemViewPrototype.setState = async () => {};
    try {
      const manager = { getThread: (id: string) => id === 'thread-a' || id === 'thread-b' ? { id } : undefined };
      const plugin = { manager, settings: { activeThreadId: 'thread-b' } };
      const view = new ThreadsView({} as never, plugin as never) as unknown as {
        activeThreadId: string | null;
        setState: (state: unknown, result: unknown) => Promise<void>;
      };
      // Exact Geode order: onOpen has already selected B, then stale workspace state A arrives.
      view.activeThreadId = 'thread-b';
      await view.setState({ activeThreadId: 'thread-a', conversationPlacement: 'conversation-first' }, {});
      expect(view.activeThreadId).toBe('thread-b');
    } finally {
      itemViewPrototype.setState = priorSetState;
    }
  });
});

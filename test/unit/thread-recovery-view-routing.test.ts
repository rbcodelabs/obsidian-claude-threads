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
vi.mock('../../src/SkillsManagerView', () => ({ ConfirmModal: class {} }));

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

  it('ThreadsView refreshes project-bar thread counts for threads_loaded', () => {
    const view = new ThreadsView({} as never, { manager: {} } as never) as unknown as {
      handleThreadListEvent: (event: { type: string }) => void;
      renderProjectBar: () => void;
    };
    const renderProjectBar = vi.spyOn(view as never, 'renderProjectBar').mockImplementation(() => {});

    view.handleThreadListEvent({ type: 'threads_loaded' });

    expect(renderProjectBar).toHaveBeenCalledOnce();
  });
});

import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { KanbanView } from '../../src/KanbanView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import {
  kanbanFixtureThreads,
  kanbanFixtureProjects,
  kanbanRunningThreadId,
  kanbanAwaitingThreadId,
  kanbanAwaitingPermission,
  kanbanRunningActivity,
} from './fixtures';
import { mockLeaf } from './obsidian-mock';

const settings = { ...DEFAULT_SETTINGS, claudeBinaryPath: '/opt/homebrew/bin/claude' };
const manager = new ThreadManager(settings);
manager.loadProjects(kanbanFixtureProjects);
manager.loadThreads(kanbanFixtureThreads);

// Running / Awaiting state lives in the manager's private session & permission
// maps, not on the Thread. Seed them directly so the Working and Awaiting
// columns render deterministically in the harness (no live Claude session).
const m = manager as unknown as {
  sessions: Map<string, unknown>;
  pendingPermissions: Map<string, { toolName: string; detail: string }>;
  threadActivity: Map<string, string>;
};
m.sessions.set(kanbanRunningThreadId, {});
m.sessions.set(kanbanAwaitingThreadId, {});
m.pendingPermissions.set(kanbanAwaitingThreadId, kanbanAwaitingPermission);
m.threadActivity.set(kanbanRunningThreadId, kanbanRunningActivity);

const mockPlugin = {
  app: (mockLeaf as any).app,
  settings,
  manager,
  persistence: null,
  saveSettings: async () => {},
  getActiveThreadId: () => null,
  openThreadInChatView: async () => {},
  dispatchNewThread: async () => 'new-thread',
};

const view = new KanbanView(mockLeaf as any, mockPlugin as any);
const container = document.getElementById('app')!;
container.appendChild(view.containerEl);
view.onOpen();

// Expose for Playwright
(window as any).__kanban = view;
(window as any).__manager = manager;
(window as any).__setGroupBy = (mode: 'status' | 'folder') => {
  settings.kanbanGroupBy = mode;
  view.render();
  // Keep the toggle button glyph/state in sync with the forced mode.
  (view as any).updateGroupByBtn?.();
};

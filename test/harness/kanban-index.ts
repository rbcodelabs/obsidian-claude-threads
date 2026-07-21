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
  kanbanWaitingThreadId,
  kanbanWaitingFireAt,
  kanbanWaitingReason,
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

// Scheduled-wakeup state (not running, has a pending wake-up) so the
// Kanban "Waiting" column renders deterministically in the harness — mirrors
// the pendingWakeups map in test/harness/index.ts.
const pendingWakeups = new Map<string, { timerId: number; fireAt: number; reason: string }[]>();
pendingWakeups.set(kanbanWaitingThreadId, [{ timerId: 0, fireAt: kanbanWaitingFireAt, reason: kanbanWaitingReason }]);

const mockPlugin = {
  app: (mockLeaf as any).app,
  settings,
  manager,
  persistence: null,
  saveSettings: async () => {},
  getActiveThreadId: () => null,
  openThreadInChatView: async () => {},
  dispatchNewThread: async () => 'new-thread',
  getPendingWakeups: (threadId: string) =>
    [...(pendingWakeups.get(threadId) ?? [])].sort((a, b) => a.fireAt - b.fireAt),
  hasPendingWakeup: (threadId: string) => (pendingWakeups.get(threadId)?.length ?? 0) > 0,
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

// ── fix/scheduled-wakeup-visibility regression helpers ──────────────────────
// Mirrors the equivalent helpers in test/harness/index.ts — lets screenshot
// tests drive the real ThreadManager → KanbanView.handleEvent → scheduleRender
// pipeline through the exact event the fix introduced, instead of calling
// view.render() directly (which would trivially pass even if the event wiring
// were missing).
(window as any).__setThreadRunning = (threadId: string, running: boolean) => {
  if (running) m.sessions.set(threadId, {});
  else m.sessions.delete(threadId);
};
(window as any).__addWakeup = (threadId: string, fireAt: number, reason: string) => {
  pendingWakeups.set(threadId, [{ timerId: 0, fireAt, reason }]);
};
(window as any).__fireRunStateSettled = (threadId: string) => {
  (manager as unknown as { emit(threadId: string, event: { type: string }): void }).emit(threadId, { type: 'run_state_settled' });
};

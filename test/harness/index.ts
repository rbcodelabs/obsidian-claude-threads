import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { ThreadsView } from '../../src/ThreadsView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { fixtureThreads } from './fixtures';
import { mockLeaf } from './obsidian-mock';

const settings = { ...DEFAULT_SETTINGS, claudeBinaryPath: '/opt/homebrew/bin/claude' };
const manager = new ThreadManager(settings);
manager.loadThreads(fixtureThreads);

// Minimal scheduler mock — ThreadsView reads this for the /loop footer pill
// and banner (renderStatusFooter / refreshLoopBanner). No fixture thread has
// a loop by default, so listItems() starts empty; tests that need to
// exercise the loop UI can call __setLoop below.
const loopItems = new Map<string, { id: string; targetThreadId: string; prompt: string; schedule: { type: 'interval'; intervalSeconds: number }; enabled: boolean; nextRun?: number }>();
const mockScheduler = {
  listItems: () => [...loopItems.values()],
  createItem: (params: any) => {
    const item = { ...params, id: `loop-${loopItems.size + 1}` };
    loopItems.set(item.id, item);
    return item;
  },
  deleteItem: (id: string) => {
    loopItems.delete(id);
  },
  updateItem: (id: string, patch: any) => {
    const existing = loopItems.get(id);
    if (!existing) throw new Error(`Scheduled item not found: ${id}`);
    const updated = { ...existing, ...patch };
    loopItems.set(id, updated);
    return updated;
  },
};

const mockPlugin = {
  app: (mockLeaf as any).app,
  settings,
  manager,
  persistence: null,
  scheduler: mockScheduler,
  summarizer: { summarize: async () => ({ title: '', summary: '' }) },
  inProcessSummarizer: {
    summarize: async () => ({ title: '', summary: '' }),
    summarizeMessage: async () => 'Fixed JWT_SECRET missing in staging by updating auth.ts to fail fast on startup.',
    generateForkPrompt: async () => 'I need to fix the authentication bug in src/auth/jwt.ts. The JWT validation is rejecting valid tokens when the expiry is within 30 seconds. We decided to add a 60-second clock skew buffer to the validation logic.',
  },
  saveSettings: async () => {},
  getEffectiveCwd: () => '/Users/mock/projects/my-app',
  getPendingWakeups: (threadId: string) =>
    [...(pendingWakeups.get(threadId) ?? [])].sort((a, b) => a.fireAt - b.fireAt),
  hasPendingWakeup: (threadId: string) => (pendingWakeups.get(threadId)?.length ?? 0) > 0,
  cancelWakeups: (threadId: string) => {
    pendingWakeups.delete(threadId);
    manager.notifyWakeupChanged(threadId);
  },
};

// Expose for Playwright — lets screenshot tests seed a loop for a thread.
(window as any).__setLoop = (threadId: string, prompt: string, intervalSeconds: number) => {
  mockScheduler.createItem({
    name: `Loop: ${prompt.slice(0, 40)}`,
    prompt,
    schedule: { type: 'interval', intervalSeconds },
    enabled: true,
    targetThreadId: threadId,
    nextRun: Date.now() + intervalSeconds * 1000,
  });
};

// Mutable wake-up state so screenshot tests can drive the waiting indicator
// through the real notifyWakeupChanged → handleEvent → refreshWakeupBanner path.
const pendingWakeups = new Map<string, { timerId: number; fireAt: number; reason: string }[]>();
(window as any).__setWakeup = (threadId: string, fireAt: number, reason: string) => {
  pendingWakeups.set(threadId, [{ timerId: 0, fireAt, reason }]);
  manager.notifyWakeupChanged(threadId);
};

const view = new ThreadsView(mockLeaf as any, mockPlugin as any);
const container = document.getElementById('app')!;
container.appendChild(view.containerEl);
view.onOpen();

// Expose for Playwright
(window as any).__view = view;
(window as any).__manager = manager;

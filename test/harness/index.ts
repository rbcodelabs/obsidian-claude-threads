import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { ThreadsView } from '../../src/ThreadsView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { fixtureThreads } from './fixtures';
import { mockLeaf } from './obsidian-mock';

const settings = { ...DEFAULT_SETTINGS, claudeBinaryPath: '/opt/homebrew/bin/claude' };
const manager = new ThreadManager(settings);
manager.loadThreads(fixtureThreads);

const mockPlugin = {
  app: (mockLeaf as any).app,
  settings,
  manager,
  persistence: null,
  summarizer: { summarize: async () => ({ title: '', summary: '' }) },
  inProcessSummarizer: {
    summarize: async () => ({ title: '', summary: '' }),
    summarizeMessage: async () => 'Fixed JWT_SECRET missing in staging by updating auth.ts to fail fast on startup.',
    generateForkPrompt: async () => 'I need to fix the authentication bug in src/auth/jwt.ts. The JWT validation is rejecting valid tokens when the expiry is within 30 seconds. We decided to add a 60-second clock skew buffer to the validation logic.',
  },
  saveSettings: async () => {},
  getEffectiveCwd: () => '/Users/mock/projects/my-app',
  getPendingWakeups: () => [],
  hasPendingWakeup: () => false,
  cancelWakeups: () => {},
};

const view = new ThreadsView(mockLeaf as any, mockPlugin as any);
const container = document.getElementById('app')!;
container.appendChild(view.containerEl);
view.onOpen();

// Expose for Playwright
(window as any).__view = view;
(window as any).__manager = manager;

import './obsidian-mock'; // must be first — sets up HTMLElement.prototype
import { ClaudeThreadsSettingTab, RequestSecretModal } from '../../src/SettingsTab';
import { DEFAULT_SETTINGS, type PluginSettings, type Project, type ScheduledItem } from '../../src/types';
import { mockApp } from './obsidian-mock';

const fixtureProjects: Project[] = [
  {
    id: 'proj-1',
    name: 'Acme Webapp',
    vaultFolder: 'Work/Acme',
    description: 'Next.js app. Prefer server components; run pnpm test before pushing.',
    createdAt: 1700000000000,
  },
  {
    id: 'proj-2',
    name: 'Personal Notes',
    vaultFolder: 'Personal',
    createdAt: 1700000100000,
  },
];

const fixtureScheduled: ScheduledItem[] = [
  {
    id: 'sched-1',
    name: 'Morning inbox triage',
    prompt: 'Triage my email inbox and summarize anything urgent.',
    schedule: { type: 'daily', timeOfDay: '09:00' },
    enabled: true,
    lastRun: 1764576000000,
    nextRun: 1764662400000,
  },
  {
    id: 'sched-2',
    name: 'Weekly PR sweep',
    prompt: 'Review and triage all open PRs.',
    schedule: { type: 'weekly', daysOfWeek: [1], timeOfDay: '08:30' },
    enabled: false,
  },
];

const settings: PluginSettings = {
  ...DEFAULT_SETTINGS,
  claudeBinaryPath: '/opt/homebrew/bin/claude',
  defaultModel: 'sonnet',
  secretEnvKeys: ['STRIPE_SECRET_KEY'],
  alwaysAllowedTools: ['Bash', 'Read', 'mcp__obsidian__obsidian_search_vault'],
  escalationEnabled: true,
  summarizationEnabled: true,
  projects: fixtureProjects,
  scheduledItems: fixtureScheduled,
};

const mockPlugin = {
  app: mockApp,
  settings,
  manager: {
    getProjects: () => settings.projects,
    updateProject: () => {},
    deleteProject: () => {},
    createProject: () => {},
    updateSettings: () => {},
  },
  scheduler: {
    updateItem: () => {},
    deleteItem: () => {},
  },
  wakeLock: { setEnabled: () => {} },
  relayClient: null,
  initDesktopRelayClient: () => {},
  initMobileRelayClient: () => {},
  saveSettings: async () => {},
  getView: () => null,
  getEffectiveCwd: () => '/Users/mock/vault',
};

const tab = new ClaudeThreadsSettingTab(mockApp as any, mockPlugin as any);
const container = document.getElementById('app')!;
container.appendChild(tab.containerEl);
tab.display();

// Expose for Playwright
(window as any).__settingsTab = tab;

/**
 * Opens a RequestSecretModal and resolves when the user saves or cancels.
 * Used by the request-secret-modal screenshot spec.
 */
(window as any).__openRequestSecretModal = (force: boolean): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const modal = new RequestSecretModal(
      mockApp as any,
      'MY_API_KEY',
      'to authenticate with the My API service',
      (saved) => resolve(saved),
      force,
    );
    modal.open();
  });

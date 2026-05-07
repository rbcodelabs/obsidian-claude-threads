import { Plugin, WorkspaceLeaf, PluginSettingTab, App, Setting } from 'obsidian';
import { ThreadsView, VIEW_TYPE } from './ThreadsView';
import { ThreadManager } from './ThreadManager';
import { VaultPersistence } from './VaultPersistence';
import { type PluginSettings, DEFAULT_SETTINGS } from './types';
import fs from 'fs';

// Electron renderer uses Chromium's AbortSignal which is missing Node.js's internal
// Symbol.for('nodejs.event_target') marker. Node's isEventTarget() checks
// obj?.constructor?.[kIsNodeEventTarget], i.e. AbortSignal[symbol] (the constructor,
// not the prototype), causing ERR_INVALID_ARG_TYPE when events.once(signal, 'abort') is called.
{
  const kNodeEventTarget = Symbol.for('nodejs.event_target');
  if (!(AbortSignal as unknown as Record<symbol, unknown>)[kNodeEventTarget]) {
    Object.defineProperty(AbortSignal, kNodeEventTarget, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
}

export default class ClaudeThreadsPlugin extends Plugin {
  settings!: PluginSettings;
  manager!: ThreadManager;
  persistence!: VaultPersistence;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.detectClaudeBinary();

    this.manager = new ThreadManager(this.settings);
    this.persistence = new VaultPersistence(this.app, this.settings.vaultFolder);

    // Load persisted threads
    const savedThreads = this.settings.threads ?? [];
    this.manager.loadThreads(savedThreads);

    // Register the view
    this.registerView(VIEW_TYPE, (leaf) => new ThreadsView(leaf, this));

    // Ribbon icon
    this.addRibbonIcon('message-square', 'Claude Threads', () => {
      this.activateView();
    });

    // Commands
    this.addCommand({
      id: 'open-claude-threads',
      name: 'Open Claude Threads',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'new-claude-thread',
      name: 'New Claude Thread',
      callback: async () => {
        await this.activateView();
        const view = this.getView();
        if (view) {
          await view.openNewThread();
        }
      },
    });

    // Settings tab
    this.addSettingTab(new ClaudeThreadsSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.manager?.destroy();

    // Persist thread state
    await this.saveSettings();
  }

  private detectClaudeBinary(): void {
    if (this.settings.claudeBinaryPath && fs.existsSync(this.settings.claudeBinaryPath)) {
      return;
    }
    const candidates = [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      `${process.env.HOME}/.local/bin/claude`,
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.settings.claudeBinaryPath = p;
        return;
      }
    }
    console.warn('[Claude Threads] claude binary not found, using "claude" from PATH');
    this.settings.claudeBinaryPath = 'claude';
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  private getView(): ThreadsView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf?.view instanceof ThreadsView ? leaf.view : null;
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    // Persist thread state (without streaming content)
    this.settings.threads = this.manager?.getThreads() ?? [];
    await this.saveData(this.settings);
  }
}

class ClaudeThreadsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ClaudeThreadsPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Claude Threads Settings' });

    new Setting(containerEl)
      .setName('Claude binary path')
      .setDesc('Path to the claude executable')
      .addText((text) =>
        text
          .setPlaceholder('/opt/homebrew/bin/claude')
          .setValue(this.plugin.settings.claudeBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.claudeBinaryPath = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default working directory')
      .setDesc('Default cwd for new threads. Leave empty to use vault root.')
      .addText((text) =>
        text
          .setPlaceholder((this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? '')
          .setValue(this.plugin.settings.defaultCwd)
          .onChange(async (value) => {
            this.plugin.settings.defaultCwd = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Save threads to vault')
      .setDesc('Auto-save conversations as Obsidian notes')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveThreadsToVault).onChange(async (value) => {
          this.plugin.settings.saveThreadsToVault = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Vault folder')
      .setDesc('Folder where thread notes are saved')
      .addText((text) =>
        text
          .setPlaceholder('Claude')
          .setValue(this.plugin.settings.vaultFolder)
          .onChange(async (value) => {
            this.plugin.settings.vaultFolder = value || 'Claude';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Permission mode')
      .setDesc('How Claude handles tool permissions')
      .addDropdown((drop) =>
        drop
          .addOption('acceptEdits', 'Accept edits automatically')
          .addOption('default', 'Prompt for permissions')
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (value) => {
            this.plugin.settings.permissionMode = value as PluginSettings['permissionMode'];
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );
  }
}

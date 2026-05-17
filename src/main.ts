import { Plugin, WorkspaceLeaf, PluginSettingTab, App, Setting, FileSystemAdapter, addIcon, Modal, Notice, Platform } from 'obsidian';
import { ThreadsView, VIEW_TYPE } from './ThreadsView';
import { AgentDashboard, AGENT_VIEW_TYPE } from './AgentDashboard';
import { ThreadManager } from './ThreadManager';
import { VaultPersistence } from './VaultPersistence';
import { InProcessSummarizer } from './InProcessSummarizer';
import { WakeLockService } from './WakeLockService';
import { type PluginSettings, DEFAULT_SETTINGS, type Project, type LayoutDensity, type ImageAttachment } from './types';
import { createObsidianMcpServer } from './ObsidianTools';
import { RelayClient } from './RelayClient';
import { MobileThreadStore } from './MobileThreadStore';
import { MobileView, MOBILE_VIEW_TYPE } from './MobileView';

// Electron renderer uses Chromium's AbortSignal which is missing Node.js's internal
// Symbol.for('nodejs.event_target') marker. Node's isEventTarget() checks
// obj?.constructor?.[kIsNodeEventTarget], i.e. AbortSignal[symbol] (the constructor,
// not the prototype), causing ERR_INVALID_ARG_TYPE when events.once(signal, 'abort') is called.
// Desktop/Electron only — mobile does not need this patch.
if (!Platform.isMobile) {
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
  inProcessSummarizer!: InProcessSummarizer;
  wakeLock!: WakeLockService;

  // Remote access (desktop and mobile)
  relayClient: RelayClient | null = null;
  mobileStore: MobileThreadStore | null = null;

  async onload(): Promise<void> {
    // Register icons that may not be in Obsidian's internal Lucide subset
    addIcon('send', '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>');
    addIcon('square', '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>');
    addIcon('wrench', '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>');
    addIcon('git-branch', '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>');
    addIcon('play', '<polygon points="6 3 20 12 6 21 6 3"/>');
    addIcon('check-circle', '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>');
    addIcon('alert-circle', '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>');
    addIcon('brain-circuit', '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>');

    // Enable SDK verbose debug logging so MCP connection errors surface to the console.
    // The SDK checks process.env.DEBUG_SDK lazily via a memoized fn — set it before any SDK call.
    // Desktop only: process.env is a Node.js global not available on mobile.
    if (!Platform.isMobile && !process.env.DEBUG_SDK) {
      process.env.DEBUG_SDK = '1';
      process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = `${process.env.HOME}/.claude/debug/claude-threads`;
      console.log('[ClaudeThreads] SDK debug logging enabled → ~/.claude/debug/claude-threads/');
    }

    await this.loadSettings();

    if (Platform.isMobile) {
      await this.onloadMobile();
    } else {
      await this.onloadDesktop();
    }

    // Settings tab (both platforms)
    this.addSettingTab(new ClaudeThreadsSettingTab(this.app, this));
  }

  private async onloadDesktop(): Promise<void> {
    this.detectClaudeBinary();

    this.manager = new ThreadManager(this.settings);
    try {
      const mcpServer = createObsidianMcpServer(this.app);
      const mcpDebug = {
        type: (mcpServer as unknown as Record<string, unknown>).type,
        name: (mcpServer as unknown as Record<string, unknown>).name,
        hasInstance: 'instance' in mcpServer,
      };
      console.log('[ClaudeThreads] Obsidian MCP server created:', mcpDebug);
      this.manager.mcpServers = { obsidian: mcpServer };
    } catch (err) {
      console.error('[ClaudeThreads] Failed to create Obsidian MCP server:', err);
    }
    this.manager.vaultRoot = this.getEffectiveCwd();
    this.persistence = new VaultPersistence(this.app, this.settings.vaultFolder);
    this.inProcessSummarizer = new InProcessSummarizer();

    // Wake lock — keep computer awake while sessions are processing
    this.wakeLock = new WakeLockService({ enabled: this.settings.wakeLockEnabled });
    const statusBarItem = this.addStatusBarItem();
    statusBarItem.style.display = 'none';
    statusBarItem.setText('☕ Keeping awake');
    statusBarItem.title = 'Claude Threads: keeping computer awake during active sessions';
    this.wakeLock.onChange((isActive) => {
      statusBarItem.style.display = isActive ? 'inline-block' : 'none';
    });
    const unsubWakeLock = this.manager.subscribe((_threadId, event) => {
      if (event.type === 'streaming_start') {
        this.wakeLock.acquire();
      } else if (event.type === 'done' || event.type === 'error') {
        this.wakeLock.release();
      }
    });
    this.register(unsubWakeLock);

    // Load persisted projects + threads
    this.manager.loadProjects(this.settings.projects ?? []);
    const savedThreads = this.settings.threads ?? [];
    this.manager.loadThreads(savedThreads);

    // Register the views
    this.registerView(VIEW_TYPE, (leaf) => new ThreadsView(leaf, this));
    this.registerView(AGENT_VIEW_TYPE, (leaf) => new AgentDashboard(leaf, this));

    // Ribbon icons
    this.addRibbonIcon('message-square', 'Claude Threads', () => {
      this.activateView();
    });
    this.addRibbonIcon('layout-dashboard', 'Agent Dashboard', () => {
      this.activateAgentView();
    });

    // Commands
    this.addCommand({
      id: 'open-claude-threads',
      name: 'Open Claude Threads',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'open-agent-dashboard',
      name: 'Open Agent Dashboard',
      callback: () => this.activateAgentView(),
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

    this.addCommand({
      id: 'next-claude-thread',
      name: 'Next Claude Thread',
      hotkeys: [{ modifiers: ['Mod'], key: ']' }],
      callback: () => this.getView()?.navigateTab(1),
    });

    this.addCommand({
      id: 'prev-claude-thread',
      name: 'Previous Claude Thread',
      hotkeys: [{ modifiers: ['Mod'], key: '[' }],
      callback: () => this.getView()?.navigateTab(-1),
    });

    for (let i = 1; i <= 9; i++) {
      const n = i;
      this.addCommand({
        id: `claude-thread-${n}`,
        name: `Switch to Claude Thread ${n}`,
        hotkeys: [{ modifiers: ['Mod'], key: String(n) }],
        callback: () => this.getView()?.switchToTabIndex(n - 1),
      });
    }

    this.addCommand({
      id: 'jump-to-latest-unreviewed',
      name: 'Jump to latest unreviewed completed agent',
      callback: () => {
        const dashboard = this.getAgentDashboard();
        if (dashboard) {
          dashboard.jumpToLatestUnreviewed();
        } else {
          // Dashboard not open — open it then jump
          this.activateAgentView().then(() => {
            this.getAgentDashboard()?.jumpToLatestUnreviewed();
          });
        }
      },
    });

    this.addCommand({
      id: 'fork-claude-thread',
      name: 'Fork current Claude thread',
      callback: async () => {
        await this.activateView();
        const view = this.getView();
        const threadId = view?.getActiveThreadId();
        if (view && threadId) view.forkThread(threadId);
      },
    });

    // Initialize relay client if remote access is enabled
    this.initDesktopRelayClient();
  }

  private async onloadMobile(): Promise<void> {
    // Mobile path: register MobileView, connect to relay if configured

    this.registerView(
      MOBILE_VIEW_TYPE,
      (leaf) => new MobileView(leaf, this.relayClient, this.mobileStore),
    );

    this.addRibbonIcon('smartphone', 'Claude Threads (Mobile)', () => {
      this.activateMobileView();
    });

    // Register URI handler for claude-threads://pair?roomId=...&relay=...
    this.registerObsidianProtocolHandler('pair', async (params) => {
      const roomId = params['roomId'];
      const relayUrl = params['relay'] ?? this.settings.remoteAccess.relayUrl;
      if (!roomId) {
        new Notice('Invalid pairing link: missing roomId');
        return;
      }
      this.settings.remoteAccess.roomId = roomId;
      this.settings.remoteAccess.relayUrl = relayUrl;
      this.settings.remoteAccess.enabled = true;
      await this.saveSettings();
      this.initMobileRelayClient();
      new Notice('Paired with desktop successfully');
      await this.activateMobileView();
    });

    // Connect if already configured
    if (this.settings.remoteAccess.roomId) {
      this.initMobileRelayClient();
    }
  }

  initDesktopRelayClient(): void {
    const ra = this.settings.remoteAccess;
    if (!ra.enabled || !ra.roomId) return;

    this.relayClient?.disconnect();
    this.relayClient = new RelayClient('desktop', ra.relayUrl, ra.roomId, this.manager);

    // Provide expiry getter so RelayClient can gate first-time joins.
    this.relayClient.getPairingExpiresAt = () => this.settings.remoteAccess.pairingExpiresAt;

    // Once the first successful join completes, mark pairing done so reconnects
    // are always allowed (expiry only guards the initial QR scan window).
    this.relayClient.onPairingComplete = () => {
      this.settings.remoteAccess.pairingExpiresAt = null;
      this.saveSettings().catch(console.error);
    };

    this.relayClient.connect();

    // Keep the relay client informed of the active thread
    const unsub = this.manager.subscribe((threadId, event) => {
      if (event.type === 'active_thread_changed') {
        this.relayClient?.setActiveThreadId(threadId);
      }
    });
    this.register(unsub);
  }

  initMobileRelayClient(): void {
    const ra = this.settings.remoteAccess;
    if (!ra.roomId) return;

    this.relayClient?.disconnect();
    this.mobileStore = new MobileThreadStore();
    this.relayClient = new RelayClient('mobile', ra.relayUrl, ra.roomId);

    const unsub = this.relayClient.onFrame((frame) => {
      this.mobileStore!.applyFrame(frame);
    });
    this.register(unsub);

    this.relayClient.connect();
  }

  async activateMobileView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(MOBILE_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: MOBILE_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  getPluginResourceUrl(): string {
    // Returns an app:// URL pointing to our plugin dist directory,
    // where we copy the .wasm files at build time.
    return this.app.vault.adapter.getResourcePath(
      `${this.manifest.dir}/`,
    );
  }

  getEffectiveCwd(): string {
    if (this.settings.defaultCwd) return this.settings.defaultCwd;
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return '';
  }

  async onunload(): Promise<void> {
    this.relayClient?.disconnect();
    this.wakeLock?.destroy();
    this.manager?.destroy();

    // Persist thread state
    await this.saveSettings();
  }

  private detectClaudeBinary(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
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

  async activateAgentView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: AGENT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async openThreadInChatView(threadId: string): Promise<void> {
    await this.activateView();
    const view = this.getView();
    view?.focusThread(threadId);
  }

  async dispatchNewThread(text: string, images?: ImageAttachment[], titleHint?: string): Promise<string> {
    const rawTitle = titleHint ?? text;
    const title = rawTitle.trim()
      ? rawTitle.slice(0, 50).split('\n')[0].trim()
      : (images && images.length > 0 ? `Image task (${images.length} image${images.length > 1 ? 's' : ''})` : 'New Thread');
    const thread = this.manager.createThread(title, this.getEffectiveCwd());
    await this.saveSettings();
    // Fire and forget — dashboard will show the running row via subscription
    this.manager.sendMessage(thread.id, text, images).catch(console.error);
    return thread.id;
  }

  getActiveThreadId(): string | null {
    return this.getView()?.getActiveThreadId() ?? null;
  }

  getView(): ThreadsView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf?.view instanceof ThreadsView ? leaf.view : null;
  }

  getAgentDashboard(): AgentDashboard | null {
    const leaf = this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
    return leaf?.view instanceof AgentDashboard ? leaf.view : null;
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Migrate old WebLLM model IDs to claude alias
    if (this.settings.inprocessModel.includes('-MLC') || this.settings.inprocessModel.includes('/')) {
      this.settings.inprocessModel = 'haiku';
    }
    // Ensure projects array exists for older data
    this.settings.projects = this.settings.projects ?? [];
    // Ensure remoteAccess block exists for installs predating this feature
    this.settings.remoteAccess = Object.assign({}, DEFAULT_SETTINGS.remoteAccess, this.settings.remoteAccess ?? {});
  }

  async saveSettings(): Promise<void> {
    // Persist projects + thread state (without streaming content)
    // manager is null on mobile — skip thread persistence there
    if (this.manager) {
      this.settings.projects = this.manager.getProjects();
      this.settings.threads = this.manager.getThreads();
    }
    await this.saveData(this.settings);
  }
}

function generateRoomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatRoomIdAsCode(roomId: string): string {
  // Format as XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 8) {
    groups.push(roomId.slice(i, i + 8).toUpperCase());
  }
  return groups.join('-');
}

class ClaudeThreadsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ClaudeThreadsPlugin,
  ) {
    super(app, plugin);
  }

  private renderProjectRow(container: HTMLElement, project: Project, refresh: () => void): void {
    const row = new Setting(container)
      .setName(project.name)
      .setDesc(`📁 ${project.vaultFolder}`);

    row.addText((text) =>
      text
        .setPlaceholder('Rename…')
        .onChange(async (val) => {
          if (val.trim()) {
            this.plugin.manager.updateProject(project.id, { name: val.trim() });
            await this.plugin.saveSettings();
          }
        }),
    );

    row.addButton((btn) =>
      btn
        .setIcon('trash')
        .setWarning()
        .setTooltip('Delete project (threads are kept)')
        .onClick(async () => {
          this.plugin.manager.deleteProject(project.id);
          await this.plugin.saveSettings();
          refresh();
        }),
    );

    new Setting(container)
      .setName('Project context')
      .setDesc('Injected into Claude\'s system prompt for every message in this project.')
      .addTextArea((area) => {
        area
          .setPlaceholder('Describe this project: goals, conventions, key files, anything Claude should always know…')
          .setValue(project.description ?? '')
          .onChange(async (val) => {
            this.plugin.manager.updateProject(project.id, { description: val });
            await this.plugin.saveSettings();
          });
        area.inputEl.rows = 4;
        area.inputEl.style.width = '100%';
      });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Claude Threads Settings' });

    new Setting(containerEl)
      .setName('Layout density')
      .setDesc('Controls how compact or spacious the conversation view feels.')
      .addDropdown((drop) =>
        drop
          .addOption('compact', 'Compact')
          .addOption('comfortable', 'Comfortable (default)')
          .addOption('spacious', 'Spacious')
          .setValue(this.plugin.settings.layoutDensity ?? 'comfortable')
          .onChange(async (value) => {
            this.plugin.settings.layoutDensity = value as LayoutDensity;
            await this.plugin.saveSettings();
            this.plugin.getView()?.applyDensity();
          }),
      );

    new Setting(containerEl)
      .setName('Keep computer awake during active sessions')
      .setDesc('Prevent the computer from sleeping while Claude is processing a response. Shows a ☕ indicator in the status bar when active.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.wakeLockEnabled).onChange(async (value) => {
          this.plugin.settings.wakeLockEnabled = value;
          this.plugin.wakeLock.setEnabled(value);
          await this.plugin.saveSettings();
        }),
      );

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
          .setPlaceholder(this.plugin.getEffectiveCwd())
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

    // ── Projects ──────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Projects' });
    containerEl.createEl('p', {
      text: 'Projects group threads and focus Claude on a specific vault sub-folder. When you open a thread inside a project, Claude\'s working directory is set to that folder.',
      cls: 'ct-settings-desc',
    });

    const projectsListEl = containerEl.createDiv({ cls: 'ct-projects-list' });
    const renderProjects = () => {
      projectsListEl.empty();
      const projects = this.plugin.manager.getProjects();
      if (projects.length === 0) {
        projectsListEl.createEl('p', { text: 'No projects yet.', cls: 'ct-allowed-tools-empty' });
      } else {
        for (const project of projects) {
          this.renderProjectRow(projectsListEl, project, renderProjects);
        }
      }
    };
    renderProjects();

    new Setting(containerEl)
      .setName('New project')
      .setDesc('Create a project scoped to a vault sub-folder')
      .addText((text) =>
        text.setPlaceholder('Project name').then((t) => {
          (t as unknown as { inputEl: HTMLInputElement }).inputEl.id = 'ct-new-project-name';
        }),
      )
      .addText((text) =>
        text.setPlaceholder('Vault folder (e.g. Work/Acme)').then((t) => {
          (t as unknown as { inputEl: HTMLInputElement }).inputEl.id = 'ct-new-project-folder';
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Add').setCta().onClick(async () => {
          const nameEl = containerEl.querySelector<HTMLInputElement>('#ct-new-project-name');
          const folderEl = containerEl.querySelector<HTMLInputElement>('#ct-new-project-folder');
          const name = nameEl?.value.trim() ?? '';
          const folder = folderEl?.value.trim() ?? '';
          if (!name || !folder) {
            new (await import('obsidian')).Notice('Enter both a project name and vault folder.');
            return;
          }
          this.plugin.manager.createProject(name, folder);
          await this.plugin.saveSettings();
          if (nameEl) nameEl.value = '';
          if (folderEl) folderEl.value = '';
          renderProjects();
        }),
      );

    // ─────────────────────────────────────────────────────────────────────

    new Setting(containerEl)
      .setName('Extra environment variables')
      .setDesc('KEY=VALUE pairs (one per line) merged into the Claude process environment. Useful for AWS SSO: set AWS_PROFILE and AWS_REGION here.')
      .addTextArea((text) =>
        text
          .setPlaceholder('AWS_PROFILE=my-sso-profile\nAWS_REGION=us-east-1')
          .setValue(this.plugin.settings.extraEnv)
          .onChange(async (value) => {
            this.plugin.settings.extraEnv = value;
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Permission mode')
      .setDesc('How Claude handles tool permissions')
      .addDropdown((drop) =>
        drop
          .addOption('acceptEdits', 'Accept edits automatically')
          .addOption('bypassPermissions', 'Bypass all permissions (trusted directories only)')
          .addOption('default', 'Prompt for permissions')
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (value) => {
            this.plugin.settings.permissionMode = value as PluginSettings['permissionMode'];
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Always allowed tools' });

    const allowedList = containerEl.createDiv({ cls: 'ct-allowed-tools-list' });
    const renderAllowedTools = () => {
      allowedList.empty();
      const tools = this.plugin.settings.alwaysAllowedTools;
      if (tools.length === 0) {
        allowedList.createEl('p', { text: 'No tools always allowed yet.', cls: 'ct-allowed-tools-empty' });
      } else {
        for (const tool of tools) {
          new Setting(allowedList)
            .setName(tool)
            .addButton((btn) =>
              btn.setButtonText('Remove').setWarning().onClick(async () => {
                this.plugin.settings.alwaysAllowedTools =
                  this.plugin.settings.alwaysAllowedTools.filter((t) => t !== tool);
                await this.plugin.saveSettings();
                renderAllowedTools();
              }),
            );
        }
      }
    };
    renderAllowedTools();

    containerEl.createEl('h3', { text: 'Opus expert escalation' });

    new Setting(containerEl)
      .setName('Enable Opus escalation')
      .setDesc('When the escalation keyword is present in a message, route that turn to claude-opus instead of the default model.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.opusEscalationEnabled).onChange(async (value) => {
          this.plugin.settings.opusEscalationEnabled = value;
          this.plugin.manager.updateSettings(this.plugin.settings);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Escalation keyword')
      .setDesc('Word or phrase that triggers Opus. Include it anywhere in your message (e.g. "/opus"). It is stripped from the prompt before sending.')
      .addText((text) =>
        text
          .setPlaceholder('/opus')
          .setValue(this.plugin.settings.opusEscalationKeyword)
          .onChange(async (value) => {
            this.plugin.settings.opusEscalationKeyword = value || '/opus';
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Thread summarization (local model)' });

    new Setting(containerEl)
      .setName('Enable summarization')
      .setDesc('Show a summarize button in each thread using a local model')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.summarizationEnabled).onChange(async (value) => {
          this.plugin.settings.summarizationEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-summarize after response')
      .setDesc('Automatically regenerate summary after each assistant turn')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSummarize).onChange(async (value) => {
          this.plugin.settings.autoSummarize = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Claude summarization model')
      .setDesc('Model alias passed to claude --model. Use "haiku" for fast/cheap, "sonnet" for higher quality.')
      .addText((text) =>
        text
          .setPlaceholder('haiku')
          .setValue(this.plugin.settings.inprocessModel)
          .onChange(async (value) => {
            this.plugin.settings.inprocessModel = value || 'haiku';
            await this.plugin.saveSettings();
          }),
      );

    // ── Remote Access ─────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Remote Access' });
    containerEl.createEl('p', {
      text: 'Connect Obsidian Mobile to this desktop instance and control Claude Threads sessions in real time.',
      cls: 'ct-settings-desc',
    });

    const ra = this.plugin.settings.remoteAccess;

    new Setting(containerEl)
      .setName('Enable remote access')
      .setDesc('Allow Obsidian Mobile to connect to this desktop via a relay server.')
      .addToggle((toggle) =>
        toggle.setValue(ra.enabled).onChange(async (value) => {
          ra.enabled = value;
          if (value && !ra.roomId) {
            ra.roomId = generateRoomId();
          }
          await this.plugin.saveSettings();
          if (value) {
            this.plugin.initDesktopRelayClient();
          } else {
            this.plugin.relayClient?.disconnect();
            this.plugin.relayClient = null;
          }
          this.display(); // Refresh to show/hide controls
        }),
      );

    if (ra.enabled && ra.roomId) {
      const maskedId = '••••••••-••••••••-••••••••-' + ra.roomId.slice(-8).toUpperCase();

      new Setting(containerEl)
        .setName('Room ID')
        .setDesc(`Your device pairing identifier. ${maskedId}`)
        .addButton((btn) =>
          btn
            .setButtonText('Show pairing QR code')
            .setCta()
            .onClick(() => {
              new PairingModal(this.app, this.plugin).open();
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText('Rotate room ID')
            .setWarning()
            .onClick(async () => {
              ra.roomId = generateRoomId();
              ra.pairingCode = null;
              ra.pairingExpiresAt = null;
              await this.plugin.saveSettings();
              this.plugin.relayClient?.disconnect();
              this.plugin.relayClient = null;
              if (ra.enabled) {
                this.plugin.initDesktopRelayClient();
              }
              this.display();
            }),
        );

      // Connection status indicator
      const isConnected = this.plugin.relayClient?.isConnected() ?? false;
      new Setting(containerEl)
        .setName('Connection status')
        .setDesc(isConnected ? 'Relay connected' : 'Relay not connected');

      new Setting(containerEl)
        .setName('Relay URL')
        .setDesc('WebSocket relay server URL. Change only if self-hosting.')
        .addText((text) =>
          text
            .setPlaceholder('wss://relay.claude-threads.rbcodelabs.com')
            .setValue(ra.relayUrl)
            .onChange(async (value) => {
              ra.relayUrl = value || 'wss://relay.claude-threads.rbcodelabs.com';
              await this.plugin.saveSettings();
            }),
        );
    }
  }
}

/** Modal that displays the pairing QR code and alphanumeric code. */
class PairingModal extends Modal {
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(app: App, private plugin: ClaudeThreadsPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ct-pairing-modal');

    const ra = this.plugin.settings.remoteAccess;

    // Set or refresh the 5-minute expiry window when the modal opens.
    ra.pairingExpiresAt = Date.now() + 5 * 60 * 1000;
    this.plugin.saveSettings().catch(console.error);

    const pairingUrl = `claude-threads://pair?roomId=${ra.roomId}&relay=${encodeURIComponent(ra.relayUrl)}`;
    const formatted = formatRoomIdAsCode(ra.roomId);

    contentEl.createEl('h2', { text: 'Pair with Mobile' });
    contentEl.createEl('p', {
      text: 'Scan this QR code from Obsidian on your mobile device, or enter the code manually in Settings > Remote Access.',
      cls: 'ct-pairing-desc',
    });

    const qrContainer = contentEl.createDiv('ct-pairing-qr');

    // Generate QR code asynchronously
    import('qrcode').then((QRCode) => {
      QRCode.toCanvas(pairingUrl, { width: 240, margin: 2 }, (err, canvas) => {
        if (err) {
          qrContainer.createEl('p', { text: 'QR code generation failed. Use the code below.' });
          return;
        }
        qrContainer.appendChild(canvas);
      });
    }).catch(() => {
      qrContainer.createEl('p', { text: 'QR code unavailable. Use the code below.' });
    });

    contentEl.createEl('p', { cls: 'ct-pairing-code-label', text: 'Pairing code:' });
    const codeEl = contentEl.createEl('code', { cls: 'ct-pairing-code', text: formatted });
    codeEl.addEventListener('click', () => {
      navigator.clipboard.writeText(ra.roomId);
      new Notice('Room ID copied to clipboard');
    });

    contentEl.createEl('p', {
      text: 'This code is your room ID. Keep it private — anyone with this code can connect to your desktop.',
      cls: 'ct-pairing-warning',
    });

    // Live countdown label
    const countdownEl = contentEl.createEl('p', { cls: 'ct-pairing-countdown' });

    const updateCountdown = () => {
      const remaining = (ra.pairingExpiresAt ?? 0) - Date.now();
      if (remaining <= 0) {
        this.expire();
        return;
      }
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      countdownEl.textContent = `Code expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
    };

    updateCountdown();
    this.countdownTimer = setInterval(updateCountdown, 1000);

    const closeBtn = contentEl.createEl('button', { text: 'Done', cls: 'mod-cta' });
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.contentEl.empty();
  }

  private expire(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    const ra = this.plugin.settings.remoteAccess;
    ra.pairingCode = null;
    ra.pairingExpiresAt = null;
    this.plugin.saveSettings().catch(console.error);
    this.close();
    new Notice('Pairing code expired. Open Settings to generate a new one.');
  }
}

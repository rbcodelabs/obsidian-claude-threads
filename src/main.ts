import { Plugin, WorkspaceLeaf, PluginSettingTab, App, Setting, FileSystemAdapter, addIcon, Modal, Notice, Platform, SecretComponent } from 'obsidian';
// Desktop-only modules: type-only imports so their module-level code never runs on mobile.
// Obsidian Mobile's require() returns null for Node.js built-ins; those modules call
// require('fs') / require('child_process') etc. at the top level, which would crash.
// The actual classes are loaded via lazy require() inside onloadDesktop() instead.
import type { ThreadsView } from './ThreadsView';
import type { AgentDashboard } from './AgentDashboard';
import type { KanbanView } from './KanbanView';
import type { ThreadManager } from './ThreadManager';
import type { VaultPersistence } from './VaultPersistence';
import type { InProcessSummarizer } from './InProcessSummarizer';
import type { WakeLockService } from './WakeLockService';
import type { createObsidianMcpServer } from './ObsidianTools';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
// Shared / mobile-safe modules (no Node.js built-in calls at module level)
import { type PluginSettings, DEFAULT_SETTINGS, type Project, type LayoutDensity, type ImageAttachment } from './types';
import { serializeKey } from './stt';
import { RelayClient } from './RelayClient';
import { MobileThreadStore } from './MobileThreadStore';
import { MobileView, MOBILE_VIEW_TYPE } from './MobileView';
import { setDebugLogging, debugLog } from './logger';

// View-type string constants. Must match the values exported by each view module.
// Defined here as literals so both desktop and mobile code can reference them without
// triggering a static import of the desktop-only view modules.
const VIEW_TYPE = 'claude-threads:chat';
const AGENT_VIEW_TYPE = 'claude-threads:agents';
const KANBAN_VIEW_TYPE = 'claude-threads:kanban';

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

  // Tracks pending ScheduleWakeup timeout IDs keyed by threadId for cleanup on unload.
  pendingWakeups = new Map<string, number[]>();

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

    await this.loadSettings();

    // Apply debug logging preference before any subsystems start.
    setDebugLogging(this.settings.debugLogging ?? false);

    // Enable SDK verbose debug logging when debug mode is on.
    // The SDK checks process.env.DEBUG_SDK lazily via a memoized fn — set it before any SDK call.
    // Desktop only: process.env is a Node.js global not available on mobile.
    if (!Platform.isMobile && this.settings.debugLogging && !process.env.DEBUG_SDK) {
      process.env.DEBUG_SDK = '1';
      process.env.CLAUDE_CODE_DEBUG_LOGS_DIR = `${process.env.HOME}/.claude/debug/claude-threads`;
      debugLog('[ClaudeThreads] SDK debug logging enabled → ~/.claude/debug/claude-threads/');
    }

    if (Platform.isMobile) {
      try {
        await this.onloadMobile();
      } catch (err) {
        console.error('[ClaudeThreads] Mobile initialization failed:', err);
        new Notice('Claude Threads failed to load on mobile. Check the developer console for details.');
      }
    } else {
      await this.onloadDesktop();
    }

    // Settings tab (both platforms)
    this.addSettingTab(new ClaudeThreadsSettingTab(this.app, this));
  }

  private async onloadDesktop(): Promise<void> {
    // Lazy-load desktop-only modules. Because these are declared as `import type`
    // at the top of the file, esbuild does not run their module-level code until
    // the require() below is first called — which only happens on desktop.
    // (On mobile we never reach this function, so Node.js built-ins are never required.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ThreadsView } = require('./ThreadsView') as typeof import('./ThreadsView');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentDashboard } = require('./AgentDashboard') as typeof import('./AgentDashboard');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { KanbanView } = require('./KanbanView') as typeof import('./KanbanView');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ThreadManager } = require('./ThreadManager') as typeof import('./ThreadManager');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { VaultPersistence } = require('./VaultPersistence') as typeof import('./VaultPersistence');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { InProcessSummarizer } = require('./InProcessSummarizer') as typeof import('./InProcessSummarizer');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WakeLockService } = require('./WakeLockService') as typeof import('./WakeLockService');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createObsidianMcpServer } = require('./ObsidianTools') as typeof import('./ObsidianTools');

    this.detectClaudeBinary();

    this.manager = new ThreadManager(this.settings);
    // Use a per-thread factory so the set_working_directory tool can close over the
    // correct threadId without shared mutable state across concurrent sessions.
    this.manager.mcpServerFactory = (threadId: string, initialCwd: string) => {
      try {
        const mcpServer = createObsidianMcpServer(this.app, {
          initialCwd,
          onSetCwd: (newCwd: string) => {
            this.manager.setThreadCwd(threadId, newCwd);
            this.saveSettings().catch(console.error);
          },
          onScheduleWakeup: (delayMs: number, prompt: string, reason: string) => {
            const id = window.setTimeout(async () => {
              try {
                if (!this.manager.getThread(threadId)) {
                  console.warn(`[ClaudeThreads] ScheduleWakeup: thread ${threadId} no longer exists, skipping`);
                  return;
                }
                await this.manager.sendMessage(threadId, prompt);
              } catch (err) {
                console.error(`[ClaudeThreads] ScheduleWakeup failed for thread ${threadId}:`, err);
              } finally {
                const ids = this.pendingWakeups.get(threadId) ?? [];
                const idx = ids.indexOf(id);
                if (idx !== -1) ids.splice(idx, 1);
              }
            }, delayMs) as unknown as number;
            const ids = this.pendingWakeups.get(threadId) ?? [];
            ids.push(id);
            this.pendingWakeups.set(threadId, ids);
            debugLog(`[ClaudeThreads] ScheduleWakeup registered for thread ${threadId} in ${delayMs}ms — ${reason}`);
          },
          onForkRequested: async (focusArea: string) => {
            const sourceThread = this.manager.getThread(threadId);
            if (!sourceThread || sourceThread.messages.filter(m => m.role !== 'compact').length === 0) {
              throw new Error('Thread has no messages to fork from.');
            }
            const forkPrompt = await this.inProcessSummarizer.generateForkPrompt(
              sourceThread.messages,
              focusArea,
              this.settings.claudeBinaryPath,
              this.settings.inprocessModel,
              this.settings.extraEnv,
            );
            const forkedThread = this.manager.createThread(
              `Fork: ${sourceThread.title.slice(0, 40)}`,
              sourceThread.cwd,
              sourceThread.projectId,
            );
            await this.saveSettings();
            // Fire-and-forget: the tool returns as soon as the thread is created and
            // the first message is queued — no need to wait for Claude's response.
            void this.manager.sendMessage(forkedThread.id, forkPrompt);
            new Notice(`Fork created: "${forkedThread.title}"`);
            return { threadTitle: forkedThread.title };
          },
        });
        const mcpDebug = {
          type: (mcpServer as unknown as Record<string, unknown>).type,
          name: (mcpServer as unknown as Record<string, unknown>).name,
          hasInstance: 'instance' in mcpServer,
        };
        debugLog(`[ClaudeThreads] Obsidian MCP server created for thread ${threadId}:`, mcpDebug);
        return { obsidian: mcpServer };
      } catch (err) {
        console.error('[ClaudeThreads] Failed to create Obsidian MCP server:', err);
        return {} as Record<string, McpServerConfig>;
      }
    };
    this.manager.vaultRoot = this.getEffectiveCwd();
    this.persistence = new VaultPersistence(this.app, this.settings.vaultFolder);
    this.inProcessSummarizer = new InProcessSummarizer();

    // Wake lock — keep computer awake while sessions are processing
    this.wakeLock = new WakeLockService({ enabled: this.settings.wakeLockEnabled });
    const statusBarItem = this.addStatusBarItem();
    statusBarItem.style.display = 'none';
    statusBarItem.setText('☕');
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

    // Persist status changes to vault for all threads (including background ones
    // not covered by the per-view save on 'message').
    const unsubStatus = this.manager.subscribe((threadId, event) => {
      if (!this.settings.saveThreadsToVault) return;
      if (event.type !== 'done' && event.type !== 'error') return;
      const thread = this.manager.getThread(threadId);
      if (thread) {
        this.persistence?.saveThread(thread).catch(console.error);
      }
    });
    this.register(unsubStatus);

    // Load persisted projects + threads
    this.manager.loadProjects(this.settings.projects ?? []);
    const savedThreads = this.settings.threads ?? [];
    this.manager.loadThreads(savedThreads);

    // Crash recovery: if data.json was cleared (e.g. after a plugin update or crash),
    // threads may be missing from memory even though their vault notes still exist.
    // Scan the vault folder and reload any threads not already in memory.
    //
    // Important guards:
    //   - Skip threads whose vault note is already marked `archived` — those were
    //     deliberately closed by the user and must not be resurrected on reload.
    //   - Reset `active` status to `waiting` — the SDK session is gone after any
    //     reload so there's nothing to resume; showing them as running would be wrong.
    if (this.settings.saveThreadsToVault) {
      try {
        const vaultThreads = await this.persistence.loadAllThreads();
        const knownIds = new Set(this.manager.getThreads().map((t) => t.id));
        const recovered = vaultThreads.filter(
          (t) => !knownIds.has(t.id) && t.status !== 'archived',
        );
        for (const t of recovered) {
          if (t.status === 'active') t.status = 'waiting';
        }
        if (recovered.length > 0) {
          this.manager.loadThreads(recovered);
          console.log(`[ClaudeThreads] Recovered ${recovered.length} thread(s) from vault notes`);
          // Write recovered threads back into data.json immediately so they survive
          // the next restart even if saveSettings() on unload is skipped.
          await this.saveSettings();
        }
      } catch (err) {
        console.error('[ClaudeThreads] Failed to recover threads from vault:', err);
      }
    }

    // Archive orphaned vault notes: thread notes written before the archive-on-close
    // feature existed still carry status=waiting even though their tabs are long gone.
    // Flip them to archived so they land in the right Bases Kanban column.
    if (this.settings.saveThreadsToVault) {
      const activeIds = new Set(this.manager.getThreads().map((t) => t.id));
      this.persistence.archiveOrphanedNotes(activeIds).then((n) => {
        if (n > 0) console.log(`[ClaudeThreads] Archived ${n} orphaned thread note(s)`);
      }).catch(console.error);
    }

    // Register the views
    this.registerView(VIEW_TYPE, (leaf) => new ThreadsView(leaf, this));
    this.registerView(AGENT_VIEW_TYPE, (leaf) => new AgentDashboard(leaf, this));
    this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf, this));

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
      id: 'open-kanban-board',
      name: 'Open Kanban Board',
      callback: () => this.activateKanbanView(),
    });

    this.addCommand({
      id: 'new-claude-thread',
      name: 'New Claude Thread',
      callback: async () => {
        await this.activateAgentView();
        this.getAgentDashboard()?.focusDispatchInput();
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

    this.addCommand({
      id: 'interrupt-active-thread',
      name: 'Interrupt active thread',
      callback: async () => {
        const threadId = this.getView()?.getActiveThreadId();
        if (threadId) {
          await this.manager.interrupt(threadId);
        }
      },
    });

    this.addCommand({
      id: 'summarize-active-thread',
      name: 'Summarize active thread',
      callback: async () => {
        await this.activateView();
        const view = this.getView();
        const threadId = view?.getActiveThreadId();
        if (view && threadId && this.settings.summarizationEnabled) {
          await view.summarizeThread(threadId);
        } else if (!this.settings.summarizationEnabled) {
          new Notice('Thread summarization is disabled. Enable it in Settings > Claude Threads > Summarization.');
        }
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

    // Register URI handler for obsidian://pair?roomId=...&relay=...
    // Triggered when the user scans the QR code on desktop (camera opens the deep link).
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

    // Cancel any pending ScheduleWakeup timers to avoid firing into a dead plugin context.
    for (const ids of this.pendingWakeups.values()) {
      for (const id of ids) window.clearTimeout(id);
    }
    this.pendingWakeups.clear();

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

  async activateKanbanView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(KANBAN_VIEW_TYPE)[0];
    if (!leaf) {
      // Open kanban as a new tab in the main area (it's a wide board)
      leaf = workspace.getLeaf('tab') as WorkspaceLeaf;
      await leaf.setViewState({ type: KANBAN_VIEW_TYPE, active: true });
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
    // getLeavesOfType only returns leaves registered with VIEW_TYPE, which is
    // always ThreadsView on desktop. Safe to cast without instanceof.
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return (leaf?.view as ThreadsView) ?? null;
  }

  getAgentDashboard(): AgentDashboard | null {
    // Same reasoning as getView().
    const leaf = this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
    return (leaf?.view as AgentDashboard) ?? null;
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
    // Clear any garbage written by the SecretComponent picker (stores key names, not values)
    const storedKey = this.app.secretStorage.getSecret('openai-api-key');
    if (storedKey && !storedKey.startsWith('sk-')) {
      this.app.secretStorage.setSecret('openai-api-key', '');
    }
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

function maskOpenAiKey(key: string | null | undefined): string {
  if (!key) return 'No key set';
  if (key.length <= 12) return '••••••••';
  return key.slice(0, 8) + '…' + key.slice(-4);
}

/** Modal for entering a new OpenAI API key directly. */
class OpenAiKeyModal extends Modal {
  constructor(app: App, private settingTab: ClaudeThreadsSettingTab) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'OpenAI API Key' });
    contentEl.createEl('p', {
      text: 'Paste your API key from platform.openai.com/api-keys',
      cls: 'setting-item-description',
    });

    const input = contentEl.createEl('input', {
      type: 'password',
      placeholder: 'sk-…',
      cls: 'ct-openai-key-input',
    });
    input.style.width = '100%';
    input.style.marginBottom = '1rem';

    const buttonRow = contentEl.createDiv('ct-modal-button-row');

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      const trimmed = input.value.trim();
      if (!trimmed) return;
      this.app.secretStorage.setSecret('openai-api-key', trimmed);
      this.close();
      this.settingTab.display();
    });

    // Allow Enter to save
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') saveBtn.click();
    });

    // Focus the input after the modal animates in
    setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Modal for linking an OpenAI key from an existing Obsidian secret. */
class LinkOpenAiSecretModal extends Modal {
  constructor(app: App, private settingTab: ClaudeThreadsSettingTab) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Link Existing Secret' });
    contentEl.createEl('p', {
      text: 'Select a secret already stored by another plugin to use as your OpenAI API key.',
      cls: 'setting-item-description',
    });

    const pickerContainer = contentEl.createDiv('ct-secret-picker');

    const secretPicker = new SecretComponent(this.app, pickerContainer);
    secretPicker.onChange((secretName: string) => {
      if (!secretName) return;
      const actualValue = this.app.secretStorage.getSecret(secretName);
      if (actualValue) {
        this.app.secretStorage.setSecret('openai-api-key', actualValue);
        new Notice('Key linked successfully');
        this.close();
        this.settingTab.display();
      } else {
        new Notice('That secret has no value stored');
      }
    });

    const cancelBtn = contentEl.createEl('button', { text: 'Cancel', cls: 'ct-modal-cancel' });
    cancelBtn.style.marginTop = '1rem';
    cancelBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
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

  /** Minimal settings shown on mobile (desktop-only settings are omitted). */
  private renderMobileOnlySettings(containerEl: HTMLElement): void {
    const ra = this.plugin.settings.remoteAccess;
    const isConnected = this.plugin.relayClient?.isConnected() ?? false;

    // Connection status banner
    const statusEl = containerEl.createDiv({ cls: 'ct-mobile-status' });
    statusEl.createEl('p', {
      text: isConnected ? 'Connected to desktop.' : 'Not connected to desktop.',
      cls: isConnected ? 'ct-mobile-status-ok' : 'ct-mobile-status-disconnected',
    });

    containerEl.createEl('h3', { text: 'Pair with desktop' });
    containerEl.createEl('p', {
      text: 'On your desktop, open Settings > Claude Threads > Remote Access, enable it, then tap "Show pairing QR code". Scan that QR code with your phone camera — your phone will ask to open Obsidian, which will connect automatically.',
      cls: 'ct-settings-desc',
    });

    // Manual pairing fallback
    containerEl.createEl('h4', { text: 'Manual pairing' });
    containerEl.createEl('p', {
      text: 'If the QR scan does not work, copy the pairing code shown on desktop and paste it below.',
      cls: 'ct-settings-desc',
    });

    let manualRoomId = '';
    new Setting(containerEl)
      .setName('Pairing code')
      .setDesc('Paste the XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX code from desktop Settings.')
      .addText((text) => {
        text
          .setPlaceholder('XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX')
          .setValue(ra.roomId ? formatRoomIdAsCode(ra.roomId) : '')
          .onChange((val) => { manualRoomId = val.trim(); });
        return text;
      })
      .addButton((btn) =>
        btn.setButtonText('Connect').setCta().onClick(async () => {
          // Accept both the formatted code (XXXX-XXXX-...) and raw hex
          const raw = manualRoomId.replace(/-/g, '').toLowerCase();
          if (!/^[0-9a-f]{32}$/.test(raw)) {
            new Notice('Invalid pairing code. Copy the code exactly from desktop Settings.');
            return;
          }
          ra.roomId = raw;
          ra.enabled = true;
          await this.plugin.saveSettings();
          this.plugin.initMobileRelayClient();
          new Notice('Connecting to desktop…');
          this.display(); // Refresh status
        }),
      );

    // Show current room ID if paired
    if (ra.roomId) {
      const maskedId = '••••••••-••••••••-••••••••-' + ra.roomId.slice(-8).toUpperCase();
      new Setting(containerEl)
        .setName('Paired room')
        .setDesc(maskedId)
        .addButton((btn) =>
          btn.setButtonText('Disconnect').setWarning().onClick(async () => {
            this.plugin.relayClient?.disconnect();
            this.plugin.relayClient = null;
            ra.roomId = '';
            ra.enabled = false;
            await this.plugin.saveSettings();
            this.display();
          }),
        );
    }

    containerEl.createEl('h3', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Relay URL')
      .setDesc('WebSocket relay server. Change only if self-hosting.')
      .addText((text) =>
        text
          .setPlaceholder('wss://claude-threads-relay.rbcodelabs.workers.dev')
          .setValue(ra.relayUrl)
          .onChange(async (value) => {
            ra.relayUrl = value || 'wss://claude-threads-relay.rbcodelabs.workers.dev';
            await this.plugin.saveSettings();
          }),
      );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Claude Threads Settings' });

    if (Platform.isMobile) {
      this.renderMobileOnlySettings(containerEl);
      return;
    }

    // ── Appearance ────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Appearance' });

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

    // ── Setup ─────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Setup' });

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Enable verbose console logs for stream events, session lifecycle, and relay connections. Turn on only when diagnosing issues — it produces a lot of output during active sessions.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogging ?? false).onChange(async (value) => {
          this.plugin.settings.debugLogging = value;
          setDebugLogging(value);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Claude binary path')
      .setDesc('Path to the claude executable. Leave empty to use the default ($PATH lookup).')
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
      .setDesc('Starting directory for new threads. Leave empty to use the vault root.')
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
      .setName('Extra environment variables')
      .setDesc('KEY=VALUE pairs (one per line) merged into the Claude process environment. Useful for AWS SSO — set AWS_PROFILE and AWS_REGION here.')
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

    // macOS privacy notice
    const macOSNote = containerEl.createDiv({ cls: 'ct-settings-notice' });
    macOSNote.createEl('strong', { text: 'macOS users: ' });
    macOSNote.appendText(
      'When Claude accesses folders like ~/Documents or ~/projects for the first time, ' +
      'macOS will show a privacy permission dialog. This is expected — click Allow to let ' +
      'Claude read and write files in that folder. These prompts only appear once per folder.',
    );

    // ── Vault ─────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Vault' });

    new Setting(containerEl)
      .setName('Save threads to vault')
      .setDesc('Auto-save conversations as Obsidian notes after each response.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveThreadsToVault).onChange(async (value) => {
          this.plugin.settings.saveThreadsToVault = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Vault folder')
      .setDesc('Folder where thread notes are saved (relative to vault root).')
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
      .setName('Context footer command')
      .setDesc(
        'Shell command that populates the context bar below the input area. ' +
        'Receives JSON on stdin with the active thread\'s cwd. ' +
        'Output is split on double-spaces into labelled pills (git branch, PR, dev URL, etc.). ' +
        'Leave empty to disable. Compatible with the Claude Code statusLine script.',
      )
      .addText((text) => {
        text
          .setPlaceholder('bash $HOME/claude-config/bin/statusline-command.sh')
          .setValue(this.plugin.settings.statusLineCommand)
          .onChange(async (value) => {
            this.plugin.settings.statusLineCommand = value;
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateStatusLineCommand();
          });
        text.inputEl.style.width = '100%';
      });

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

    // ── Claude Behavior ───────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Claude Behavior' });

    new Setting(containerEl)
      .setName('Permission mode')
      .setDesc('How Claude handles tool-use permission prompts.')
      .addDropdown((drop) =>
        drop
          .addOption('default', 'Prompt for permissions')
          .addOption('acceptEdits', 'Accept edits automatically')
          .addOption('bypassPermissions', 'Bypass all permissions (trusted directories only)')
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (value) => {
            this.plugin.settings.permissionMode = value as PluginSettings['permissionMode'];
            this.plugin.manager.updateSettings(this.plugin.settings);
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('p', {
      text: 'Always-allowed tools are granted permission automatically without prompting. Tools are added here when you choose "Always allow" in a permission prompt. You can remove individual entries below.',
      cls: 'ct-settings-desc',
    });

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

    new Setting(containerEl)
      .setName('Add always-allowed tool')
      .setDesc('Manually allow a tool by name (e.g. mcp__obsidian__read_file, Bash, Read).')
      .addText((text) =>
        text.setPlaceholder('Tool name').then((t) => {
          (t as unknown as { inputEl: HTMLInputElement }).inputEl.id = 'ct-new-allowed-tool';
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Add').setCta().onClick(async () => {
          const input = containerEl.querySelector<HTMLInputElement>('#ct-new-allowed-tool');
          const tool = input?.value.trim() ?? '';
          if (!tool) return;
          if (!this.plugin.settings.alwaysAllowedTools.includes(tool)) {
            this.plugin.settings.alwaysAllowedTools.push(tool);
            await this.plugin.saveSettings();
            renderAllowedTools();
          }
          if (input) input.value = '';
        }),
      );

    new Setting(containerEl)
      .setName('Opus escalation')
      .setDesc('When the escalation keyword appears in a message, route that turn to claude-opus instead of the default model. The keyword is stripped before sending.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.opusEscalationEnabled).onChange(async (value) => {
          this.plugin.settings.opusEscalationEnabled = value;
          this.plugin.manager.updateSettings(this.plugin.settings);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Escalation keyword')
      .setDesc('Word or phrase that triggers Opus (e.g. "/opus").')
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

    // ── Summarization ─────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Summarization' });
    containerEl.createEl('p', {
      text: 'Generates a short summary and suggested title for each thread using the Claude CLI. Useful for keeping the agent dashboard readable at a glance.',
      cls: 'ct-settings-desc',
    });

    new Setting(containerEl)
      .setName('Enable summarization')
      .setDesc('Show a Summarize button in each thread and enable the "Summarize active thread" command.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.summarizationEnabled).onChange(async (value) => {
          this.plugin.settings.summarizationEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-summarize after response')
      .setDesc('Automatically regenerate the summary after each assistant turn.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSummarize).onChange(async (value) => {
          this.plugin.settings.autoSummarize = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Summarization model')
      .setDesc('Model alias passed to claude --model. Use "haiku" for fast and cheap, "sonnet" for higher quality.')
      .addText((text) =>
        text
          .setPlaceholder('haiku')
          .setValue(this.plugin.settings.inprocessModel)
          .onChange(async (value) => {
            this.plugin.settings.inprocessModel = value || 'haiku';
            await this.plugin.saveSettings();
          }),
      );

    // ── Speech to Text ────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Speech to Text' });

    {
      const existingKey = this.app.secretStorage.getSecret('openai-api-key');
      const maskedKey = maskOpenAiKey(existingKey);
      const openAiSetting = new Setting(containerEl)
        .setName('OpenAI API Key')
        .setDesc('Used for Whisper speech-to-text. Stored securely in your OS keychain.');

      openAiSetting.descEl.createEl('br');
      openAiSetting.descEl.createEl('span', {
        text: maskedKey,
        cls: 'ct-openai-key-display',
      });

      openAiSetting
        .addButton((btn) => {
          if (!existingKey) btn.setCta();
          btn.setButtonText(existingKey ? 'Set key' : 'Set key').onClick(() => {
            new OpenAiKeyModal(this.app, this).open();
          });
        })
        .addButton((btn) => {
          btn.setButtonText('Link existing').setTooltip('Use a key already stored by another plugin').onClick(() => {
            new LinkOpenAiSecretModal(this.app, this).open();
          });
        });
    }

    new Setting(containerEl)
      .setName('PTT Hotkey')
      .setDesc('Hold this key while focused in any input to record. Default: Alt+Space (Option+Space on Mac).')
      .addButton((btn) => {
        const updateLabel = () => {
          btn.setButtonText(this.plugin.settings.pttKey || 'Click to set');
        };
        updateLabel();
        btn.onClick(() => {
          btn.setButtonText('Press a key…');
          btn.buttonEl.classList.add('mod-warning');
          const capture = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const key = serializeKey(e);
            if (!key) return; // bare modifier — wait for a real key
            window.removeEventListener('keydown', capture, true);
            btn.buttonEl.classList.remove('mod-warning');
            this.plugin.settings.pttKey = key;
            void this.plugin.saveSettings();
            updateLabel();
          };
          window.addEventListener('keydown', capture, true);
        });
      })
      .addExtraButton((btn) => {
        btn.setIcon('rotate-ccw').setTooltip('Reset to Alt+Space');
        btn.onClick(() => {
          this.plugin.settings.pttKey = 'Alt+Space';
          void this.plugin.saveSettings();
          // Re-render settings tab to update button label
          this.display();
        });
      });

    // ── Remote Access ─────────────────────────────────────────────────────
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

      const isConnected = this.plugin.relayClient?.isConnected() ?? false;
      new Setting(containerEl)
        .setName('Connection status')
        .setDesc(isConnected ? 'Mobile relay connected' : 'Mobile relay not connected');

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

    // obsidian:// deep link — iOS/Android camera apps will offer "Open in Obsidian"
    // when the user scans this QR code. registerObsidianProtocolHandler('pair', ...)
    // handles obsidian://pair?... on the mobile side.
    const pairingUrl = `obsidian://pair?roomId=${ra.roomId}&relay=${encodeURIComponent(ra.relayUrl)}`;
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

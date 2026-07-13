import { Plugin, WorkspaceLeaf, App, FileSystemAdapter, addIcon, Notice, Platform, normalizePath, TFile, Modal } from 'obsidian';
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
import type { SkillsManagerView } from './SkillsManagerView';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
// Shared / mobile-safe modules (no Node.js built-in calls at module level)
import { type PluginSettings, DEFAULT_SETTINGS, effectiveExtraEnv, type Project, type ImageAttachment } from './types';
import { getVaultBridgesAPI, findBridgesForFiles, type BridgeInfo } from './bridgeUtils';
import { ClaudeThreadsSettingTab, isWebViewerEnabled, RequestSecretModal } from './SettingsTab';
import { RelayClient } from './RelayClient';
import { MobileThreadStore } from './MobileThreadStore';
import { MobileView, MOBILE_VIEW_TYPE } from './MobileView';
import { setDebugLogging, debugLog } from './logger';
import { secretStorageKey } from './secretUtils';

// View-type string constants. Must match the values exported by each view module.
// Defined here as literals so both desktop and mobile code can reference them without
// triggering a static import of the desktop-only view modules.
const VIEW_TYPE = 'claude-threads:chat';
const AGENT_VIEW_TYPE = 'claude-threads:agents';
const KANBAN_VIEW_TYPE = 'claude-threads:kanban';
const SKILLS_VIEW_TYPE = 'claude-threads:skills';

// Welcome guide content — written to vault on first install
const WELCOME_GUIDE = `# Getting Started with Claude Threads

Welcome! Claude Threads turns Obsidian into a multi-agent workspace powered by the Claude CLI.

## The three panels

| Panel | Location | What it does |
|---|---|---|
| **Chat** | Left sidebar | Full conversation history for each thread |
| **Agent Dashboard** | Right sidebar | Dispatch tasks, track running agents, review results |
| **This guide** | Center | You're reading it — save it anywhere in your vault |

Reopen the panels any time from the ribbon icons (left edge of the window) or via the command palette (\`Cmd+P\`).

## Starting your first task

1. Click the **Agent Dashboard** ribbon icon or press \`Cmd+P\` → "Open Agent Dashboard"
2. Type a task in the **dispatch box** at the top — e.g. \`Summarize the README in my project folder\`
3. Hit **Enter** — Claude spins up a new thread and starts working
4. Watch progress in the dashboard; click any thread row to open the full conversation in Chat

## Tips

- **Projects**: Group threads by folder. Create a project in the dashboard to scope Claude's working directory.
- **Permission mode**: Set to "Accept Edits" in Settings → Claude Threads to let Claude edit files without prompting.
- **Multiple threads**: Run several agents in parallel — each gets its own row in the dashboard.
- **Keyboard shortcuts**: \`Cmd+]\` / \`Cmd+[\` to cycle threads in Chat; \`Cmd+1–9\` to jump to a specific thread.
- **Interrupt**: Use "Interrupt active thread" from the command palette to stop a running agent mid-task.

## Settings

Open **Settings → Claude Threads** to configure:
- Claude binary path (auto-detected from Homebrew/PATH)
- Default working directory
- Vault folder for saving thread notes
- Summarization and auto-compact options
- Remote access (pair with Obsidian Mobile)
`;

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

/** A scheduled ScheduleWakeup timer awaiting fire, tracked per thread. */
export interface PendingWakeup {
  /** window.setTimeout handle, used to clear the timer on cancel/unload. */
  timerId: number;
  /** Wall-clock epoch ms at which the wake-up will fire. Drives the UI countdown. */
  fireAt: number;
  /** Agent-supplied reason for the wake-up, surfaced in the dashboard and banner. */
  reason: string;
}

export default class ClaudeThreadsPlugin extends Plugin {
  settings!: PluginSettings;
  manager!: ThreadManager;
  persistence!: VaultPersistence;
  inProcessSummarizer!: InProcessSummarizer;
  wakeLock!: WakeLockService;
  scheduler!: import('./Scheduler').Scheduler;
  statusLine: import('./StatusLineService').StatusLineService | null = null;

  // Remote access (desktop and mobile)
  relayClient: RelayClient | null = null;
  mobileStore: MobileThreadStore | null = null;

  /**
   * Models discovered from the Claude Code CLI via the SDK capabilities query.
   * Populated after the first session starts; used by SettingsTab to build
   * dynamic model dropdowns. Deduplicated by model value across sessions.
   */
  discoveredModels: import('@anthropic-ai/claude-agent-sdk').ModelInfo[] = [];

  // Tracks pending ScheduleWakeup timers keyed by threadId. Each entry carries
  // the timer ID (for cleanup/cancel), the wall-clock fire time (for the UI
  // countdown), and the agent-supplied reason (shown in the dashboard + banner).
  pendingWakeups = new Map<string, PendingWakeup[]>();

  // Tracks background-task-monitor timeout IDs keyed by threadId (one timer per thread at a time).
  private pendingBgTaskTimers = new Map<string, number>();

  /** Maximum number of poll attempts per thread before giving up on background task monitoring. */
  private static readonly BG_TASK_MAX_POLLS = 10;
  /** How long to wait between background task poll attempts. */
  private static readonly BG_TASK_POLL_INTERVAL_MS = 30_000;

  async onload(): Promise<void> {
    // Register icons that may not be in Obsidian's internal Lucide subset
    addIcon('send', '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>');
    addIcon('square', '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>');
    addIcon('wrench', '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>');
    // git-branch is in Obsidian's built-in Lucide subset — no custom registration needed.
    // (Registering it here with 24×24 paths in a 100×100 viewBox would make it invisible.)
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
    const { Scheduler } = require('./Scheduler') as typeof import('./Scheduler');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createObsidianMcpServer, computeUiStatus } = require('./ObsidianTools') as typeof import('./ObsidianTools');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SkillsManagerView } = require('./SkillsManagerView') as typeof import('./SkillsManagerView');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StatusLineService } = require('./StatusLineService') as typeof import('./StatusLineService');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readClaudeSettingsMcp } = require('./claudeSettingsMcp') as typeof import('./claudeSettingsMcp');

    this.detectClaudeBinary();
    this.migrateGithubSourcesIntoVault();

    this.manager = new ThreadManager(this.settings);
    // Use a per-thread factory so the set_working_directory tool can close over the
    // correct threadId without shared mutable state across concurrent sessions.
    this.manager.mcpServerFactory = (threadId: string, initialCwd: string) => {
      try {
        const mcpServer = createObsidianMcpServer(this.app, {
          enableOpenUrl: (this.settings.enableWebViewerTool ?? true) && isWebViewerEnabled(this.app),
          initialCwd,
          onSetCwd: (newCwd: string) => {
            this.manager.setThreadCwd(threadId, newCwd);
            this.saveSettings().catch(console.error);
          },
          onScheduleWakeup: (delayMs: number, prompt: string, reason: string) => {
            const id = window.setTimeout(async () => {
              // Drop this entry before firing so the UI stops showing "waiting"
              // the moment the wake-up triggers, even while sendMessage runs.
              const list = this.pendingWakeups.get(threadId) ?? [];
              const idx = list.findIndex(w => w.timerId === id);
              if (idx !== -1) list.splice(idx, 1);
              if (list.length === 0) this.pendingWakeups.delete(threadId);
              this.manager.notifyWakeupChanged(threadId);
              try {
                if (!this.manager.getThread(threadId)) {
                  console.warn(`[ClaudeThreads] ScheduleWakeup: thread ${threadId} no longer exists, skipping`);
                  return;
                }
                await this.manager.sendMessage(threadId, prompt);
              } catch (err) {
                console.error(`[ClaudeThreads] ScheduleWakeup failed for thread ${threadId}:`, err);
              }
            }, delayMs) as unknown as number;
            const list = this.pendingWakeups.get(threadId) ?? [];
            list.push({ timerId: id, fireAt: Date.now() + delayMs, reason });
            this.pendingWakeups.set(threadId, list);
            this.manager.notifyWakeupChanged(threadId);
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
              effectiveExtraEnv(this.settings),
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
          threadId,
          getThreadDetail: (id: string) => {
            const t = this.manager.getThread(id);
            if (!t) return undefined;
            const nonCompact = t.messages.filter((m: { role: string }) => m.role !== 'compact');
            const isRunning = this.manager.isRunning(id);
            return {
              id: t.id,
              title: t.title,
              status: t.status ?? 'waiting',
              uiStatus: computeUiStatus({
                isRunning,
                lastError: t.lastError,
                messageCount: nonCompact.length,
                reviewed: t.reviewed,
              }),
              isRunning,
              lastError: t.lastError,
              reviewed: t.reviewed,
              projectId: t.projectId,
              cwd: t.cwd,
              prUrl: t.prUrl,
              updatedAt: t.updatedAt,
              messageCount: nonCompact.length,
              rawLogPath: t.rawLogPath,
              messages: nonCompact.map((m: { id: string; role: string; content: string; timestamp: number }) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
              })),
            };
          },
          getAllThreads: () => this.manager.getThreads().map((t: { id: string; title: string; status?: string; lastError?: string; reviewed?: boolean; projectId?: string; cwd?: string; prUrl?: string; updatedAt: number; rawLogPath?: string; messages: Array<{ role: string }> }) => {
            const isRunning = this.manager.isRunning(t.id);
            const messageCount = t.messages.filter((m: { role: string }) => m.role !== 'compact').length;
            return {
              id: t.id,
              title: t.title,
              status: t.status ?? 'waiting',
              uiStatus: computeUiStatus({
                isRunning,
                lastError: t.lastError,
                messageCount,
                reviewed: t.reviewed,
              }),
              isRunning,
              lastError: t.lastError,
              reviewed: t.reviewed,
              projectId: t.projectId,
              cwd: t.cwd,
              prUrl: t.prUrl,
              updatedAt: t.updatedAt,
              messageCount,
              rawLogPath: t.rawLogPath,
            };
          }),
          getAllProjects: () => this.manager.getProjects().map((p: { id: string; name: string; description?: string; vaultFolder?: string }) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            vaultFolder: p.vaultFolder,
          })),
          createProject: (name, vaultFolder, description, cwdOverride) => {
            const p = this.manager.createProject(name, vaultFolder, description, cwdOverride);
            this.saveSettings().catch(console.error);
            return { id: p.id, name: p.name, description: p.description, vaultFolder: p.vaultFolder };
          },
          setThreadProject: (threadId, projectId) => {
            const thread = this.manager.getThread(threadId);
            if (!thread) throw new Error(`Thread not found: ${threadId}`);
            thread.projectId = projectId ?? undefined;
            this.saveSettings().catch(console.error);
          },
          readThreadLog: (id: string, opts: { limit?: number; type?: string }) => this.manager.readRawLog(id, opts),
          isThreadRunning: (id: string) => this.manager.isRunning(id),
          sendMessageToThread: (id: string, message: string) => this.manager.sendMessage(id, message),
          archiveThread: async (id: string) => {
            const thread = this.manager.getThread(id);
            if (!thread) throw new Error(`Thread not found: ${id}`);
            if (this.settings.saveThreadsToVault && this.persistence) {
              thread.status = 'archived';
              await this.persistence.saveThread(thread);
            }
            this.manager.deleteThread(id);
            await this.saveSettings();
          },
          onCronCreate: (params) => this.scheduler.createItem(params),
          onCronList: () => this.scheduler.listItems(),
          onCronUpdate: (id, patch) => this.scheduler.updateItem(id, patch),
          onCronDelete: (id) => this.scheduler.deleteItem(id),
          onRequestSecret: (secretName: string, reason: string, force?: boolean) => {
            return new Promise<boolean>((resolve) => {
              new RequestSecretModal(this.app, secretName, reason, async (saved) => {
                if (saved) {
                  if (!this.settings.secretEnvKeys.includes(secretName)) {
                    this.settings.secretEnvKeys.push(secretName);
                    await this.saveSettings();
                  }
                }
                resolve(saved);
              }, force).open();
            });
          },
        });
        const mcpDebug = {
          type: (mcpServer as unknown as Record<string, unknown>).type,
          name: (mcpServer as unknown as Record<string, unknown>).name,
          hasInstance: 'instance' in mcpServer,
        };
        debugLog(`[ClaudeThreads] Obsidian MCP server created for thread ${threadId}:`, mcpDebug);

        // Merge external MCP servers from ~/.claude/settings.json so that
        // scheduled/looped sessions have the same tools as a normal CLI session.
        // Secrets stored in the plugin keychain are resolved and used to expand
        // ${VAR_NAME} placeholders in server configs (e.g. Authorization headers).
        const resolvedSecrets = this.manager.secretEnvResolver?.() ?? {};
        const externalMcps = readClaudeSettingsMcp(resolvedSecrets);
        const externalCount = Object.keys(externalMcps).length;
        if (externalCount > 0) {
          debugLog(`[ClaudeThreads] Merging ${externalCount} external MCP server(s) from ~/.claude/settings.json:`, Object.keys(externalMcps));
        }

        return { obsidian: mcpServer, ...externalMcps };
      } catch (err) {
        console.error('[ClaudeThreads] Failed to create Obsidian MCP server:', err);
        return {} as Record<string, McpServerConfig>;
      }
    };
    this.manager.vaultRoot = this.getEffectiveCwd();
    // Resolve secret env vars from the OS keychain at session start. Values are
    // never stored in settings — only the key names live in data.json.
    this.manager.secretEnvResolver = () => {
      const result: Record<string, string> = {};
      for (const varName of this.settings.secretEnvKeys ?? []) {
        const val = this.app.secretStorage.getSecret(secretStorageKey(varName));
        if (val) result[varName] = val;
      }
      return result;
    };
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

    // Persist cwd repairs to data.json. repairStaleCwds() (called below at load
    // time) already calls saveSettings() directly, but the session-start safety-net
    // in ThreadManager also emits cwd_changed — catch those here so the repaired
    // path survives the next plugin reload.
    const unsubCwdRepair = this.manager.subscribe((_threadId, event) => {
      if (event.type === 'cwd_changed') {
        this.saveSettings().catch(console.error);
      }
    });
    this.register(unsubCwdRepair);

    // Persist pending plan text so the plan card survives a reload/crash.
    const unsubPendingPlan = this.manager.subscribe((_threadId, event) => {
      if (event.type === 'pending_plan_changed') {
        this.saveSettings().catch(console.error);
      }
    });
    this.register(unsubPendingPlan);

    // Background task monitoring: when a session ends with unresolved background
    // tasks, schedule an automatic poll to check completion.
    const unsubBgTasks = this.manager.subscribe((threadId, event) => {
      if (event.type === 'background_tasks_pending') {
        this.scheduleBgTaskPoll(threadId, event.tasks);
      } else if (event.type === 'task_notification') {
        // A background task resolved. If no tasks remain, cancel the poll timer.
        const remaining = this.manager.getPendingBackgroundTasks(threadId);
        if (remaining.length === 0) {
          this.cancelBgTaskPoll(threadId);
        }
        // Show a notice when the notification arrives on an idle thread (the
        // ThreadsView task-pill handles it when the thread is actively streaming).
        if (!this.manager.isRunning(threadId)) {
          const icon = event.status === 'completed' ? '✓' : '✗';
          new Notice(`Background task ${icon}: ${event.summary}`, 5000);
        }
        // Persist the updated (cleared) pending task list.
        this.saveSettings().catch(console.error);
      }
    });
    this.register(unsubBgTasks);

    // Bridge-aware repo edits: when a turn writes files that live inside a
    // Vault Bridge's source repo (rather than the synced vault copy), trigger
    // a bridge pull at end of turn so the vault copies refresh immediately.
    const pendingBridgeEdits = new Map<string, Set<string>>();
    const bridgeSyncsInFlight = new Set<string>();
    const unsubBridgeSync = this.manager.subscribe((threadId, event) => {
      if (event.type === 'tool_use') {
        if (event.record.name === 'Write' || event.record.name === 'Edit') {
          const filePath = event.record.summary.replace(/^[^:]+: /, '');
          if (filePath) {
            let set = pendingBridgeEdits.get(threadId);
            if (!set) {
              set = new Set();
              pendingBridgeEdits.set(threadId, set);
            }
            set.add(filePath);
          }
        }
        return;
      }
      if (event.type !== 'done' && event.type !== 'error') return;
      const files = pendingBridgeEdits.get(threadId);
      pendingBridgeEdits.delete(threadId);
      if (!files || files.size === 0) return;
      const api = getVaultBridgesAPI(this.app);
      if (!api) return;
      let bridges: BridgeInfo[];
      try {
        bridges = api.getBridges();
      } catch (err) {
        console.error('[Claude Threads] could not read vault bridges:', err);
        return;
      }
      for (const bridge of findBridgesForFiles(files, bridges)) {
        if (bridgeSyncsInFlight.has(bridge.id)) continue;
        bridgeSyncsInFlight.add(bridge.id);
        api
          .syncBridge(bridge.id)
          .then(() => new Notice(`Vault bridge pulled: ${bridge.name}`))
          .catch((err: unknown) => {
            console.error('[Claude Threads] bridge sync failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Vault bridge sync failed: ${bridge.name}: ${msg}`, 8000);
          })
          .finally(() => bridgeSyncsInFlight.delete(bridge.id));
      }
    });
    this.register(unsubBridgeSync);

    // Load persisted projects + threads
    this.manager.loadProjects(this.settings.projects ?? []);
    const savedThreads = this.settings.threads ?? [];
    this.manager.loadThreads(savedThreads);

    // Initialize the built-in scheduler
    this.scheduler = new Scheduler({
      getItems: () => this.settings.scheduledItems ?? [],
      saveItem: async (item) => {
        if (!this.settings.scheduledItems) this.settings.scheduledItems = [];
        const idx = this.settings.scheduledItems.findIndex((i) => i.id === item.id);
        if (idx >= 0) this.settings.scheduledItems[idx] = item;
        else this.settings.scheduledItems.push(item);
        await this.saveSettings();
      },
      removeItem: async (id) => {
        this.settings.scheduledItems = (this.settings.scheduledItems ?? []).filter((i) => i.id !== id);
        await this.saveSettings();
      },
      createThread: (title, cwd, projectId) => {
        const thread = this.manager.createThread(title, cwd, projectId);
        // Scheduled sessions should not block on permission prompts. When the
        // global permissionMode is 'default' (ask every time), override to
        // 'dontAsk' so unattended runs complete without hanging.
        if (!thread.permissionMode && this.settings.permissionMode === 'default') {
          thread.permissionMode = 'dontAsk';
        }
        return thread;
      },
      sendMessage: (threadId, prompt) => this.manager.sendMessage(threadId, prompt),
      getDefaultCwd: () => this.getEffectiveCwd(),
      threadExists: (threadId) => !!this.manager.getThread(threadId),
      isThreadBusy: (threadId) => this.manager.isRunning(threadId),
    });
    this.scheduler.start(this.settings.scheduledItems ?? []);

    // Status-line service: polls statusLineCommand per thread cwd so every
    // thread's footer pills + derived prUrl stay fresh (desktop only).
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const childProcess = require('child_process') as typeof import('child_process');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const osMod = require('os') as typeof import('os');
      this.statusLine = new StatusLineService(
        this.manager,
        () => ({
          statusLineCommand: this.settings.statusLineCommand,
          statusLineIntervalMs: this.settings.statusLineIntervalMs,
          provider: this.settings.provider,
        }),
        {
          exec: childProcess.exec,
          now: () => Date.now(),
          homedir: () => osMod.homedir(),
          isMobile: Platform.isMobile,
          getDefaultCwd: () => this.getEffectiveCwd(),
          // Idle-pause interval polls when no relevant view is open and nothing runs;
          // event-triggered polls (done/cwd_changed/focus) still fire.
          shouldPoll: () => {
            const ws = this.app.workspace;
            const anyViewOpen =
              ws.getLeavesOfType(VIEW_TYPE).length > 0 ||
              ws.getLeavesOfType(AGENT_VIEW_TYPE).length > 0 ||
              ws.getLeavesOfType(KANBAN_VIEW_TYPE).length > 0;
            const anyRunning = this.manager.getThreads().some((t) => this.manager.isRunning(t.id));
            return anyViewOpen || anyRunning;
          },
        },
      );
      this.statusLine.start();
    }

    // Repair any threads whose cwd points to a deleted worktree. Worktrees created
    // by enter_worktree live in os.tmpdir()/claude-worktrees/ and are removed by
    // exit_worktree, the worktree-cleanup skill, or the Agent tool's auto-cleanup.
    // When that happens outside the plugin, the persisted cwd becomes a dangling path
    // that causes a misleading "binary not found" ENOENT on the next message send.
    {
      const repairedCount = this.manager.repairStaleCwds();
      if (repairedCount > 0) {
        console.log(`[ClaudeThreads] Repaired ${repairedCount} thread(s) with stale working director${repairedCount === 1 ? 'y' : 'ies'}`);
        await this.saveSettings();
      }
    }

    // Archive orphaned vault notes FIRST — before crash recovery runs.
    //
    // Notes with status:waiting that are not in data.json would be incorrectly
    // treated as "crashed" threads and resurrected if crash recovery ran first.
    // Common cause: closeThread's async vault save didn't finish before a quick
    // Obsidian restart, leaving the note with status:waiting even though the thread
    // was deliberately closed.
    //
    // By running the orphan scan synchronously first we ensure every stale
    // status:waiting note is flipped to archived before crash recovery even looks.
    // The scan uses the metadata cache for a fast pre-check (zero extra disk reads
    // for already-archived notes or notes belonging to known active threads).
    //
    // Skip once the scan has completed — the flag is reset any time crash recovery
    // loads threads so we always re-scan after a genuine data.json loss.
    if (this.settings.saveThreadsToVault && !this.settings.orphanArchiveScanComplete) {
      const activeIds = new Set(this.manager.getThreads().map((t) => t.id));
      try {
        const n = await this.persistence.archiveOrphanedNotes(activeIds);
        if (n > 0) console.log(`[ClaudeThreads] Archived ${n} orphaned thread note(s)`);
      } catch (err) {
        console.error('[ClaudeThreads] Failed to archive orphaned notes:', err);
      }
      this.settings.orphanArchiveScanComplete = true;
      await this.saveSettings();
    }

    // Crash recovery: if data.json was cleared (e.g. after a plugin update or crash),
    // threads may be missing from memory even though their vault notes still exist.
    // Scan the vault folder and reload any threads not already in memory.
    //
    // Important guards:
    //   - Skip threads whose vault note is already marked `archived` — those were
    //     deliberately closed by the user and must not be resurrected on reload.
    //     The orphan scan above ensures stale status:waiting notes are archived
    //     before we reach this point.
    //   - Reset `active` status to `waiting` — the SDK session is gone after any
    //     reload so there's nothing to resume; showing them as running would be wrong.
    //
    // Performance: use the metadata cache (already built by Obsidian during vault
    // init, zero disk reads) to check whether any vault thread notes are missing
    // from data.json before doing the expensive full file-read scan.
    if (this.settings.saveThreadsToVault) {
      const knownIds = new Set(this.manager.getThreads().map((t) => t.id));
      const vaultFolder = this.settings.vaultFolder;
      const hasUnknownThreads = this.app.vault.getMarkdownFiles()
        .filter((f) => f.path.startsWith(vaultFolder + '/'))
        .some((f) => {
          const tid = this.app.metadataCache.getFileCache(f)?.frontmatter?.['thread_id'];
          return tid && !knownIds.has(String(tid));
        });

      if (hasUnknownThreads) {
        try {
          const vaultThreads = await this.persistence.loadAllThreads();
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
            // Reset the orphan-archive flag so the next startup re-scans for any
            // notes that may have been left in waiting state during the crash.
            this.settings.orphanArchiveScanComplete = false;
            await this.saveSettings();
          }
        } catch (err) {
          console.error('[ClaudeThreads] Failed to recover threads from vault:', err);
        }
      }
    }

    // Resume background task monitoring for any threads that still had pending
    // tasks when the plugin was last unloaded (e.g. Obsidian restart mid-task).
    for (const thread of this.manager.getThreads()) {
      const pending = this.manager.getPendingBackgroundTasks(thread.id);
      if (pending.length > 0) {
        debugLog(`[ClaudeThreads] Resuming bg task monitoring for thread ${thread.id} (${pending.length} task(s) pending)`);
        this.scheduleBgTaskPoll(thread.id, pending);
      }
    }

    // Register the views
    this.registerView(VIEW_TYPE, (leaf) => new ThreadsView(leaf, this));
    this.registerView(AGENT_VIEW_TYPE, (leaf) => new AgentDashboard(leaf, this));
    this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf, this));
    this.registerView(SKILLS_VIEW_TYPE, (leaf) => new SkillsManagerView(leaf, this));

    // Ribbon icons
    this.addRibbonIcon('message-square', 'Claude Threads', () => {
      this.activateView();
    });
    this.addRibbonIcon('layout-dashboard', 'Agent Dashboard', () => {
      this.activateAgentView();
    });
    this.addRibbonIcon('puzzle', 'Skills Manager', () => {
      this.activateSkillsView();
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
      id: 'open-skills-manager',
      name: 'Open Skills Manager',
      callback: () => this.activateSkillsView(),
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
      callback: () => this.getView()?.navigateTab(1),
    });

    this.addCommand({
      id: 'prev-claude-thread',
      name: 'Previous Claude Thread',
      callback: () => this.getView()?.navigateTab(-1),
    });

    for (let i = 1; i <= 9; i++) {
      const n = i;
      this.addCommand({
        id: `claude-thread-${n}`,
        name: `Switch to Claude Thread ${n}`,
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

    this.addCommand({
      id: 'reload-plugin-safely',
      name: 'Reload plugin (safe)',
      callback: async () => {
        if (!this.manager) {
          await this.safeReloadPlugin();
          return;
        }
        const running = this.manager.getRunningThreads();
        if (running.length === 0) {
          await this.safeReloadPlugin();
          return;
        }
        new ActiveThreadsReloadModal(this.app, running, async (action) => {
          if (action === 'cancel') return;
          if (action === 'graceful') {
            new Notice(
              `Interrupting ${running.length} thread${running.length === 1 ? '' : 's'}… waiting up to 30 s.`,
              32_000,
            );
            await this.manager!.gracefulShutdown(30_000);
          }
          await this.safeReloadPlugin();
        }).open();
      },
    });

    // Initialize relay client if remote access is enabled
    this.initDesktopRelayClient();

    // First-run onboarding: auto-open panels + welcome guide for brand-new installs.
    // Migration guard: if the user already has threads they're upgrading from a prior
    // version — mark hasSeenWelcome silently rather than hijacking their layout.
    if (!this.settings.hasSeenWelcome) {
      if (this.settings.threads.length === 0) {
        this.app.workspace.onLayoutReady(() => {
          this.firstRunSetup().catch(console.error);
        });
      } else {
        // Existing user upgrading — skip onboarding, just flip the flag
        this.settings.hasSeenWelcome = true;
        this.saveSettings().catch(console.error);
      }
    }
  }

  private async firstRunSetup(): Promise<void> {
    const { workspace, vault } = this.app;

    // 1. Write welcome guide to vault
    const guidePath = normalizePath(`${this.settings.vaultFolder}/Getting Started with Claude Threads.md`);
    try {
      if (!vault.getAbstractFileByPath(guidePath)) {
        const folderPath = normalizePath(this.settings.vaultFolder);
        if (!vault.getAbstractFileByPath(folderPath)) {
          await vault.createFolder(folderPath);
        }
        await vault.create(guidePath, WELCOME_GUIDE);
      }
    } catch (err) {
      console.error('[ClaudeThreads] Failed to create welcome guide:', err);
    }

    // 2. Open chat view in the LEFT sidebar
    try {
      if (!workspace.getLeavesOfType(VIEW_TYPE)[0]) {
        const chatLeaf = workspace.getLeftLeaf(false) as WorkspaceLeaf;
        await chatLeaf.setViewState({ type: VIEW_TYPE, active: false });
      }
    } catch (err) {
      console.error('[ClaudeThreads] Failed to open chat in left sidebar:', err);
    }

    // 3. Open welcome guide in the CENTER editor
    try {
      const guideFile = vault.getAbstractFileByPath(guidePath);
      if (guideFile instanceof TFile) {
        const centerLeaf = workspace.getLeaf('tab');
        await centerLeaf.openFile(guideFile);
        workspace.revealLeaf(centerLeaf);
      }
    } catch (err) {
      console.error('[ClaudeThreads] Failed to open welcome guide:', err);
    }

    // 4. Open agent dashboard in the RIGHT sidebar
    try {
      const existingDash = workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
      if (!existingDash) {
        const dashLeaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
        await dashLeaf.setViewState({ type: AGENT_VIEW_TYPE, active: true });
        workspace.revealLeaf(dashLeaf);
      } else {
        workspace.revealLeaf(existingDash);
      }
    } catch (err) {
      console.error('[ClaudeThreads] Failed to open agent dashboard:', err);
    }

    // 5. Welcome notice
    new Notice('Welcome to Claude Threads! Check the guide to get started.');

    // 6. Persist the flag so this never fires again
    this.settings.hasSeenWelcome = true;
    await this.saveSettings();
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

    // 3.11 — When mobile sends Always Allow, persist the tool name to settings.
    this.relayClient.onAlwaysAllowTool = (toolName: string) => {
      if (!this.settings.alwaysAllowedTools.includes(toolName)) {
        this.settings.alwaysAllowedTools.push(toolName);
        this.saveSettings().catch(console.error);
      }
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

  /**
   * One-time migration: move skill-source clones from the old global location
   * (~/.claude/skill-sources/<id>) into the vault-local plugin folder
   * (<vault>/.obsidian/plugins/claude-threads/skill-sources/<id>).
   * Safe to call on every load — skips sources whose clonePath already points
   * inside the vault, or whose old path no longer exists.
   */
  private migrateGithubSourcesIntoVault(): void {
    const sources = this.settings.skillSources ?? [];
    const githubSources = sources.filter(s => s.type === 'github' && s.clonePath);
    if (githubSources.length === 0) return;

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const vaultRoot = adapter.getBasePath();
    const vaultLocal = require('path').join(vaultRoot, this.manifest.dir!, 'skill-sources');
    const fs = require('fs') as typeof import('fs');

    let changed = false;
    for (const source of githubSources) {
      const oldPath = source.clonePath!;
      // Already vault-local — nothing to do
      if (oldPath.startsWith(vaultLocal)) continue;
      // Old clone must exist on disk to be moveable
      if (!fs.existsSync(oldPath)) continue;

      const newPath = require('path').join(vaultLocal, source.id);
      try {
        fs.mkdirSync(vaultLocal, { recursive: true });
        fs.renameSync(oldPath, newPath);
        source.clonePath = newPath;
        changed = true;
      } catch (err) {
        console.warn('[ClaudeThreads] skill-source migration failed for', source.name, err);
      }
    }

    if (changed) {
      this.saveSettings().catch(err =>
        console.error('[ClaudeThreads] failed to save settings after skill-source migration', err),
      );
    }
  }

  getEffectiveCwd(): string {
    if (this.settings.defaultCwd) return this.settings.defaultCwd;
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return '';
  }

  /**
   * Pending ScheduleWakeup timers for a thread, soonest-to-fire first.
   * Returns an empty array when the thread has none.
   */
  getPendingWakeups(threadId: string): PendingWakeup[] {
    const list = this.pendingWakeups.get(threadId);
    if (!list || list.length === 0) return [];
    return [...list].sort((a, b) => a.fireAt - b.fireAt);
  }

  /** Whether a thread has at least one scheduled wake-up awaiting fire. */
  hasPendingWakeup(threadId: string): boolean {
    return (this.pendingWakeups.get(threadId)?.length ?? 0) > 0;
  }

  /**
   * Cancel all pending wake-ups for a thread (user clicked "Cancel"). Clears the
   * underlying timers and notifies the views so the waiting indicator disappears.
   */
  cancelWakeups(threadId: string): void {
    const list = this.pendingWakeups.get(threadId);
    if (!list || list.length === 0) return;
    for (const w of list) window.clearTimeout(w.timerId);
    this.pendingWakeups.delete(threadId);
    this.manager.notifyWakeupChanged(threadId);
    debugLog(`[ClaudeThreads] Cancelled ${list.length} pending wake-up(s) for thread ${threadId}`);
  }

  async onunload(): Promise<void> {
    // ── Safe-reload guard ────────────────────────────────────────────────────
    // If any agent threads are actively running, interrupt them and wait up to
    // 10 seconds for clean shutdown before forcibly closing sessions.
    // Note: Obsidian's Component.unload() does not await onunload(), so this
    // best-effort wait runs on the microtask queue after Obsidian's own cleanup
    // starts — but sessions receive their interrupt signal synchronously before
    // that, giving them maximum time to shut down cleanly.
    if (this.manager) {
      const runningThreads = this.manager.getRunningThreads();
      if (runningThreads.length > 0) {
        const names = runningThreads.map((t) => `"${t.title}"`).join(', ');
        const s = runningThreads.length === 1 ? '' : 's';
        new Notice(
          `Claude Threads: interrupting ${runningThreads.length} active thread${s} (${names}). Waiting up to 10 s for clean shutdown…`,
          12_000,
        );
        console.warn(`[ClaudeThreads] Plugin unloading with ${runningThreads.length} active thread${s}: ${names}`);
        const { timedOut } = await this.manager.gracefulShutdown(10_000);
        if (timedOut) {
          console.warn('[ClaudeThreads] Graceful shutdown timed out — forcing session close.');
          new Notice('Claude Threads: some threads did not stop in time and were force-closed.', 6_000);
        }
      }
    }

    this.relayClient?.disconnect();
    this.wakeLock?.destroy();
    this.statusLine?.stop();
    this.manager?.destroy();

    // Cancel any pending ScheduleWakeup timers to avoid firing into a dead plugin context.
    for (const list of this.pendingWakeups.values()) {
      for (const w of list) window.clearTimeout(w.timerId);
    }
    this.pendingWakeups.clear();

    // Cancel background task poll timers.
    for (const id of this.pendingBgTaskTimers.values()) {
      window.clearTimeout(id);
    }
    this.pendingBgTaskTimers.clear();

    // Stop scheduler timers
    this.scheduler?.destroy();

    // Persist thread state to data.json
    await this.saveSettings();

    // Also flush all non-archived threads to vault notes so crash recovery
    // always sees fresh content.  The per-event saves (on 'done') are
    // fire-and-forget and may not complete before the plugin unloads; this
    // catch-all guarantees vault notes are consistent with data.json.
    if (this.persistence && this.settings.saveThreadsToVault && this.manager) {
      const threads = this.manager.getThreads().filter((t) => t.status !== 'archived');
      await Promise.all(threads.map((t) => this.persistence!.saveThread(t).catch(console.error)));
    }
  }

  // ── Background task monitoring ───────────────────────────────────────────────

  /**
   * Schedule a poll for pending background tasks. Fires after BG_TASK_POLL_INTERVAL_MS,
   * then resumes the thread with a lightweight monitor prompt that asks Claude to check
   * task status via TaskOutput/Monitor and report or re-schedule as needed.
   *
   * Only one timer is active per thread at a time. If a timer already exists it is
   * cancelled before the new one is registered.
   */
  private scheduleBgTaskPoll(threadId: string, tasks: import('./types').PendingBackgroundTask[]): void {
    this.cancelBgTaskPoll(threadId);

    // Filter to tasks that haven't exceeded the poll limit.
    const activeTasks = tasks.filter(t => t.pollCount < ClaudeThreadsPlugin.BG_TASK_MAX_POLLS);
    if (activeTasks.length === 0) {
      console.warn(`[ClaudeThreads] Background task polling gave up for thread ${threadId} after ${ClaudeThreadsPlugin.BG_TASK_MAX_POLLS} attempts`);
      new Notice(
        `Background task check timed out after ${ClaudeThreadsPlugin.BG_TASK_MAX_POLLS} attempts. Resume the thread manually to check status.`,
        10_000,
      );
      this.manager.clearAllPendingBackgroundTasks(threadId);
      this.saveSettings().catch(console.error);
      return;
    }

    const elapsed = (taskMs: number) => {
      const secs = Math.round((Date.now() - taskMs) / 1000);
      return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
    };
    const taskList = activeTasks
      .map(t => `- ${t.description} (running for ${elapsed(t.startedAt)})`)
      .join('\n');
    const pollPrompt =
      `[Background Monitor] The following background task(s) were started in this session and ` +
      `may still be running:\n${taskList}\n\n` +
      `Please check each task's status using TaskOutput or Monitor. ` +
      `If a task has completed or failed, report the result. ` +
      `If tasks are still running, use ScheduleWakeup to check again in 30 seconds.`;

    const id = window.setTimeout(async () => {
      this.pendingBgTaskTimers.delete(threadId);
      try {
        if (!this.manager.getThread(threadId)) {
          debugLog(`[ClaudeThreads] Bg task poll skipped — thread ${threadId} no longer exists`);
          return;
        }
        this.manager.incrementPendingTaskPollCount(threadId);
        await this.manager.sendMessage(threadId, pollPrompt);
      } catch (err) {
        console.error(`[ClaudeThreads] Background task poll failed for thread ${threadId}:`, err);
      }
    }, ClaudeThreadsPlugin.BG_TASK_POLL_INTERVAL_MS) as unknown as number;

    this.pendingBgTaskTimers.set(threadId, id);
    debugLog(
      `[ClaudeThreads] Background task poll scheduled for thread ${threadId} ` +
      `in ${ClaudeThreadsPlugin.BG_TASK_POLL_INTERVAL_MS / 1000}s (${activeTasks.length} task(s))`,
    );
  }

  private cancelBgTaskPoll(threadId: string): void {
    const id = this.pendingBgTaskTimers.get(threadId);
    if (id !== undefined) {
      window.clearTimeout(id);
      this.pendingBgTaskTimers.delete(threadId);
    }
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

  async activateSkillsView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(SKILLS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: SKILLS_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async openThreadInChatView(threadId: string): Promise<void> {
    await this.activateView();
    const view = this.getView();
    view?.focusThread(threadId);
  }

  async dispatchNewThread(
    text: string,
    images?: ImageAttachment[],
    titleHint?: string,
    opts?: {
      /** Model override applied before the first message (/model prefix). */
      model?: string;
      /** Persistent goal set on the new thread (/goal prefix). */
      goal?: string;
      /** Recurring loop registered on the new thread (/loop prefix). The
       * loop re-sends `text` every intervalSeconds; the first iteration is
       * the dispatch itself. */
      loop?: { intervalSeconds: number };
    },
  ): Promise<string> {
    const rawTitle = titleHint ?? text;
    const title = rawTitle.trim()
      ? rawTitle.slice(0, 50).split('\n')[0].trim()
      : (images && images.length > 0 ? `Image task (${images.length} image${images.length > 1 ? 's' : ''})` : 'New Thread');
    const thread = this.manager.createThread(title, this.getEffectiveCwd());
    if (opts?.model) this.manager.setThreadModel(thread.id, opts.model);
    if (opts?.goal) this.manager.setThreadGoal(thread.id, opts.goal);
    if (opts?.loop) {
      this.scheduler.createItem({
        name: `Loop: ${text.slice(0, 40)}`,
        prompt: text,
        schedule: { type: 'interval', intervalSeconds: opts.loop.intervalSeconds },
        enabled: true,
        cwd: thread.cwd,
        projectId: thread.projectId,
        targetThreadId: thread.id,
      });
    }
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
    const view = leaf?.view;
    // Guard against half-initialised or mismatched view objects (can occur during
    // workspace restore when the leaf exists but the view class hasn't fully loaded).
    if (!view || typeof (view as any).getActiveThreadId !== 'function') return null;
    return view as ThreadsView;
  }

  getAgentDashboard(): AgentDashboard | null {
    const leaf = this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE)[0];
    const view = leaf?.view;
    if (!view || typeof (view as any).focusDispatchInput !== 'function') return null;
    return view as AgentDashboard;
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
    // Ensure secretEnvKeys array exists for installs predating this feature
    this.settings.secretEnvKeys = this.settings.secretEnvKeys ?? [];
    // Ensure scheduledItems array exists for installs predating this feature
    this.settings.scheduledItems = this.settings.scheduledItems ?? [];
    // Ensure remoteAccess block exists for installs predating this feature
    this.settings.remoteAccess = Object.assign({}, DEFAULT_SETTINGS.remoteAccess, this.settings.remoteAccess ?? {});
    // Migrate pre-v0.15 "Opus escalation" settings to the generic escalation
    // settings (escalationEnabled/escalationKeyword/escalationModel). The old
    // '/opus' default keyword becomes '/escalate'; custom keywords are kept.
    {
      const legacy = (data ?? {}) as Record<string, unknown>;
      if (legacy.escalationEnabled === undefined && typeof legacy.opusEscalationEnabled === 'boolean') {
        this.settings.escalationEnabled = legacy.opusEscalationEnabled;
      }
      if (legacy.escalationKeyword === undefined && typeof legacy.opusEscalationKeyword === 'string') {
        this.settings.escalationKeyword =
          legacy.opusEscalationKeyword === '/opus' ? '/escalate' : legacy.opusEscalationKeyword;
      }
      // Drop the legacy keys (carried onto settings by Object.assign) so they
      // disappear from data.json on the next save.
      delete (this.settings as unknown as Record<string, unknown>).opusEscalationEnabled;
      delete (this.settings as unknown as Record<string, unknown>).opusEscalationKeyword;
    }
    // Clear any garbage written by the SecretComponent picker (stores key names, not values)
    const storedKey = this.app.secretStorage.getSecret('openai-api-key');
    if (storedKey && !storedKey.startsWith('sk-')) {
      this.app.secretStorage.setSecret('openai-api-key', '');
    }
  }

  /**
   * Reload this plugin via Obsidian's internal plugin API.
   * Equivalent to toggling the plugin off and on in Settings › Community Plugins.
   */
  async safeReloadPlugin(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugins = (this.app as any).plugins as {
      disablePlugin: (id: string) => Promise<void>;
      enablePlugin: (id: string) => Promise<void>;
    } | undefined;
    if (!plugins) {
      new Notice('Unable to reload: Obsidian plugin API not available.', 4_000);
      return;
    }
    const id = this.manifest.id;
    await plugins.disablePlugin(id);
    await plugins.enablePlugin(id);
  }

  async saveSettings(): Promise<void> {
    // Persist projects + thread state (without streaming content)
    // manager is null on mobile — skip thread persistence there
    if (this.manager) {
      this.settings.projects = this.manager.getProjects();
      // Strip ephemeral statusTags — they are re-derived each poll and must not
      // bloat data.json or render as stale pills after a restart.
      this.settings.threads = this.manager.getThreads().map((t) => {
        if (!t.statusTags) return t;
        const { statusTags: _omit, ...rest } = t;
        return rest as typeof t;
      });
    }
    await this.saveData(this.settings);
  }
}

// ── Safe-Reload Modal ──────────────────────────────────────────────────────────

type ReloadAction = 'cancel' | 'force' | 'graceful';

/**
 * Shown when the user invokes "Reload plugin (safe)" while agent threads are
 * actively running.  Presents the thread list and three choices:
 *
 *  • Cancel          — dismiss, do nothing
 *  • Interrupt & Reload — interrupt all sessions (up to 30 s) then reload
 *  • Force Reload     — reload immediately, killing active threads
 */
class ActiveThreadsReloadModal extends Modal {
  private threads: import('./types').Thread[];
  private onAction: (action: ReloadAction) => Promise<void>;

  constructor(
    app: App,
    threads: import('./types').Thread[],
    onAction: (action: ReloadAction) => Promise<void>,
  ) {
    super(app);
    this.threads = threads;
    this.onAction = onAction;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('ct-safe-reload-modal');

    contentEl.createEl('h2', { text: 'Active threads detected' });

    const s = this.threads.length === 1 ? '' : 's';
    contentEl.createEl('p', {
      text: `${this.threads.length} thread${s} ${this.threads.length === 1 ? 'is' : 'are'} currently running. Reloading the plugin will kill ${this.threads.length === 1 ? 'it' : 'them'} immediately unless you interrupt first.`,
    });

    const list = contentEl.createEl('ul', { cls: 'ct-safe-reload-thread-list' });
    for (const t of this.threads) {
      list.createEl('li', { text: t.title });
    }

    const btnRow = contentEl.createEl('div', { cls: 'ct-safe-reload-btns' });

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.close();
      this.onAction('cancel').catch(console.error);
    });

    const gracefulBtn = btnRow.createEl('button', {
      text: 'Interrupt & Reload',
      cls: 'mod-cta',
    });
    gracefulBtn.addEventListener('click', () => {
      this.close();
      this.onAction('graceful').catch(console.error);
    });

    const forceBtn = btnRow.createEl('button', {
      text: 'Force Reload',
      cls: 'mod-warning',
    });
    forceBtn.addEventListener('click', () => {
      this.close();
      this.onAction('force').catch(console.error);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

import { ClaudeSession } from './ClaudeSession';
import type { Thread, ChatMessage, PluginSettings, ToolCallRecord, AskQuestion, ImageAttachment, Project, PendingBackgroundTask } from './types';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

type ThreadStateListener = (threadId: string, event: ThreadEvent) => void;

export type ThreadEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_use'; record: ToolCallRecord }
  | { type: 'message'; message: ChatMessage }
  | { type: 'recap'; summary: string }
  | { type: 'done' }
  | { type: 'error'; error: Error }
  | { type: 'streaming_start' }
  | { type: 'escalated'; model: string }
  | { type: 'queued'; text: string; images?: ImageAttachment[] }
  | { type: 'dequeued'; text: string; images?: ImageAttachment[] }
  | { type: 'status'; status: 'compacting' | 'requesting' | null }
  | { type: 'compact'; message: ChatMessage }
  | { type: 'task_started'; taskId: string; description: string; skipTranscript: boolean }
  | { type: 'task_progress'; taskId: string; description: string; lastToolName?: string }
  | { type: 'task_notification'; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string }
  | { type: 'background_tasks_pending'; tasks: PendingBackgroundTask[] }
  | { type: 'notification'; text: string; priority: 'low' | 'medium' | 'high' | 'immediate' }
  | { type: 'api_retry'; attempt: number; maxRetries: number; error: string }
  | { type: 'rate_limit'; limitStatus: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number }
  | { type: 'interrupted' }
  | { type: 'cwd_changed'; cwd: string }
  | { type: 'thread_deleted' }
  | { type: 'thread_created' }
  | { type: 'thread_renamed'; threadId: string; title: string }
  | { type: 'permission_request'; toolName: string; detail: string }
  | { type: 'permission_resolved' }
  | { type: 'active_thread_changed' }
  | { type: 'user_message_added'; message: ChatMessage }
  | { type: 'summary_updated' };

export class ThreadManager {
  private threads: Map<string, Thread> = new Map();
  private projects: Map<string, Project> = new Map();
  private sessions: Map<string, ClaudeSession> = new Map();
  private queuedMessages: Map<string, { text: string; images?: ImageAttachment[] }[]> = new Map();
  private threadActivity: Map<string, string> = new Map();
  private pendingPermissions: Map<string, { toolName: string; detail: string }> = new Map();
  private permissionResolvers: Map<string, (allow: boolean) => void> = new Map();
  /** Remote permission resolvers keyed by requestId (used by RelayClient). */
  private remotePermissionResolvers: Map<string, (allow: boolean) => void> = new Map();
  private listeners: Set<ThreadStateListener> = new Set();
  private settings: PluginSettings;
  mcpServers: Record<string, McpServerConfig> | undefined = undefined;
  /**
   * When set, called before each session run to produce per-thread MCP server configs.
   * Preferred over `mcpServers` when present — allows baking a thread-specific callback
   * (e.g. onSetCwd) into the server without shared mutable state across concurrent threads.
   */
  mcpServerFactory: ((threadId: string, initialCwd: string) => Record<string, McpServerConfig>) | undefined = undefined;
  /**
   * When set, called before each session run to resolve secret env var values from
   * the OS keychain. Returns a plain key-value map that is merged into the session
   * environment. Only ever called at session start — values are not cached or stored.
   */
  secretEnvResolver: (() => Record<string, string>) | undefined = undefined;
  permissionHandler: (threadId: string, toolName: string, detail: string) => Promise<boolean> = async () => false;
  questionHandler: (questions: AskQuestion[]) => Promise<Record<string, string>> = async () => ({});
  openNewTabHandler: (title?: string, initialPrompt?: string) => Promise<{ threadId: string; title: string }> = async (title) => ({ threadId: '', title: title ?? 'New Thread' });
  vaultRoot = '';

  constructor(settings: PluginSettings) {
    this.settings = settings;
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  loadProjects(projects: Project[]): void {
    for (const p of projects) {
      this.projects.set(p.id, p);
    }
  }

  getProjects(): Project[] {
    return Array.from(this.projects.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  createProject(name: string, vaultFolder: string, description?: string, cwdOverride?: string): Project {
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim() || 'Untitled Project',
      description,
      vaultFolder: vaultFolder.trim(),
      cwdOverride,
      createdAt: Date.now(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  updateProject(id: string, updates: Partial<Omit<Project, 'id' | 'createdAt'>>): void {
    const project = this.projects.get(id);
    if (project) Object.assign(project, updates);
  }

  deleteProject(id: string): void {
    this.projects.delete(id);
    // Detach threads that belonged to this project
    for (const thread of this.threads.values()) {
      if (thread.projectId === id) thread.projectId = undefined;
    }
  }

  /**
   * Returns the resolved filesystem cwd for a project. Uses cwdOverride if
   * set, otherwise joins vaultRoot + vaultFolder.
   */
  getProjectCwd(project: Project): string {
    if (project.cwdOverride) return project.cwdOverride;
    if (!this.vaultRoot) return project.vaultFolder;
    const path = require('path') as typeof import('path');
    return path.join(this.vaultRoot, project.vaultFolder);
  }

  // ── Threads ──────────────────────────────────────────────────────────────────

  loadThreads(threads: Thread[]): void {
    for (const t of threads) {
      // Migrate threads persisted before status was introduced.
      if (!t.status) t.status = 'waiting';
      // Migrate threads persisted before updatedAt was introduced so that the
      // Kanban byRecency sort never sees undefined (NaN comparisons break sort).
      if (!t.updatedAt) t.updatedAt = t.createdAt;
      this.threads.set(t.id, t);
    }
  }

  getThreads(): Thread[] {
    return Array.from(this.threads.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getThreadsByProject(projectId: string | null): Thread[] {
    const all = this.getThreads();
    if (projectId === null) return all;
    return all.filter((t) => t.projectId === projectId);
  }

  getThread(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  createThread(title: string, cwd?: string, projectId?: string): Thread {
    const thread: Thread = {
      id: crypto.randomUUID(),
      title: title || `Thread ${this.threads.size + 1}`,
      cwd: cwd ?? this.settings.defaultCwd,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectId,
      status: 'waiting',
    };
    this.threads.set(thread.id, thread);
    this.emit(thread.id, { type: 'thread_created' });
    return thread;
  }

  deleteThread(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.close();
      this.sessions.delete(id);
    }
    this.queuedMessages.delete(id);
    this.threadActivity.delete(id);
    this.threads.delete(id);
    this.emit(id, { type: 'thread_deleted' });
  }

  renameThread(id: string, title: string): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.title = title;
      thread.updatedAt = Date.now();
      this.emit(id, { type: 'thread_renamed', threadId: id, title });
    }
  }

  setThreadCwd(id: string, cwd: string): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.cwd = cwd;
      // Session IDs are scoped to a Claude Code project directory. Resuming a
      // session from the old cwd in the new cwd's project directory will fail with
      // "No conversation found with session ID". Clear it so the next turn starts
      // fresh in the new directory.
      thread.sessionId = undefined;
      thread.updatedAt = Date.now();
      this.emit(id, { type: 'cwd_changed', cwd });
    }
  }

  /**
   * Scans all threads and repairs any whose `cwd` is a stale worktree path.
   *
   * Worktrees created by `enter_worktree` live under `<tmpdir>/claude-worktrees/`
   * and are volatile — the Agent tool auto-removes them, and the worktree-cleanup
   * skill prunes them on demand. When that happens outside the plugin's awareness,
   * the persisted `thread.cwd` becomes a dangling path. Node.js throws ENOENT when
   * spawning Claude with a non-existent cwd, which the SDK surfaces as the
   * misleading "binary not found" error.
   *
   * **Scope**: only paths under `<os.tmpdir()>/claude-worktrees/` are repaired.
   * Other missing cwds (e.g. a deleted project directory) are left alone — those
   * should surface as an explicit error so the user knows to update the path.
   *
   * For each stale worktree path this method:
   *   1. Walks up the directory tree to the nearest valid ancestor, stopping before
   *      the worktree container dir itself.
   *   2. Falls back to `vaultRoot` or `os.homedir()` if no valid ancestor is found.
   *   3. Calls `setThreadCwd()` so the session ID is cleared and `cwd_changed` fires
   *      (giving callers a chance to persist the fix via `saveSettings()`).
   *
   * Returns the number of threads that were repaired.
   */
  repairStaleCwds(): number {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');

    // Worktree container: <os.tmpdir()>/claude-worktrees  (and its real-path twin on
    // macOS where /tmp → /private/tmp).
    const worktreeContainer = nodePath.join(os.tmpdir(), 'claude-worktrees');
    const realWorktreeContainer = (() => {
      try { return fs.realpathSync(nodePath.dirname(worktreeContainer)) + nodePath.sep + nodePath.basename(worktreeContainer); }
      catch { return worktreeContainer; }
    })();

    const isWorktreePath = (p: string) =>
      p.startsWith(worktreeContainer + nodePath.sep) ||
      p.startsWith(realWorktreeContainer + nodePath.sep);

    const isWorktreeContainer = (p: string) =>
      p === worktreeContainer || p === realWorktreeContainer;

    let repaired = 0;

    for (const [id, thread] of this.threads) {
      // Only repair volatile worktree paths — other non-existent cwds should be
      // surfaced as an explicit error, not silently rerouted.
      if (!thread.cwd || !isWorktreePath(thread.cwd)) continue;
      if (fs.existsSync(thread.cwd)) continue;

      // Walk up the tree to the nearest ancestor that both exists and is not
      // the worktree container directory itself.
      let fallback = thread.cwd;
      while (true) {
        const parent = nodePath.dirname(fallback);
        if (parent === fallback) { fallback = ''; break; } // hit filesystem root
        fallback = parent;
        if (fs.existsSync(fallback) && !isWorktreeContainer(fallback)) break;
      }

      if (!fallback || !fs.existsSync(fallback)) {
        fallback = this.vaultRoot || os.homedir();
      }

      console.warn(
        `[ClaudeThreads] Repairing stale worktree cwd for thread "${thread.title}": ` +
        `"${thread.cwd}" → "${fallback}"`,
      );
      this.setThreadCwd(id, fallback);
      repaired++;
    }

    return repaired;
  }

  setThreadModel(id: string, model: string | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.model = model;
      thread.updatedAt = Date.now();
    }
  }

  isRunning(id: string): boolean {
    return this.sessions.has(id);
  }

  hasPendingPermission(threadId: string): boolean {
    return this.pendingPermissions.has(threadId);
  }

  getPendingPermission(threadId: string): { toolName: string; detail: string } | undefined {
    return this.pendingPermissions.get(threadId);
  }

  registerPermissionResolver(threadId: string, resolver: (allow: boolean) => void): void {
    this.permissionResolvers.set(threadId, resolver);
  }

  resolvePermission(threadId: string, allow: boolean): void {
    const resolver = this.permissionResolvers.get(threadId);
    if (resolver) resolver(allow);
  }

  /**
   * Resolve a permission that was issued with a specific requestId (used by
   * RelayClient for remote permission resolution from a mobile client).
   */
  resolvePermissionByRequestId(requestId: string, allow: boolean): void {
    const resolver = this.remotePermissionResolvers.get(requestId);
    if (resolver) {
      this.remotePermissionResolvers.delete(requestId);
      resolver(allow);
    }
  }

  /**
   * Register a resolver keyed by a stable requestId so that RelayClient can
   * bridge remote resolve_permission commands to the correct local promise.
   */
  registerRemotePermissionResolver(requestId: string, resolver: (allow: boolean) => void): void {
    this.remotePermissionResolvers.set(requestId, resolver);
  }

  getQueuedMessage(id: string): string | undefined {
    const queue = this.queuedMessages.get(id);
    return queue && queue.length > 0 ? queue[0].text : undefined;
  }

  getQueuedCount(id: string): number {
    return this.queuedMessages.get(id)?.length ?? 0;
  }

  getThreadActivity(id: string): string | undefined {
    return this.threadActivity.get(id);
  }

  // ── Background task tracking ─────────────────────────────────────────────────

  getPendingBackgroundTasks(threadId: string): PendingBackgroundTask[] {
    return this.threads.get(threadId)?.pendingBackgroundTasks ?? [];
  }

  /** Remove a single resolved task from the thread's pending list. */
  clearPendingBackgroundTask(threadId: string, taskId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread?.pendingBackgroundTasks) return;
    thread.pendingBackgroundTasks = thread.pendingBackgroundTasks.filter(t => t.taskId !== taskId);
    if (thread.pendingBackgroundTasks.length === 0) {
      delete thread.pendingBackgroundTasks;
    }
  }

  /** Clear ALL pending background tasks for a thread (e.g. when giving up after max polls). */
  clearAllPendingBackgroundTasks(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread) delete thread.pendingBackgroundTasks;
  }

  /** Increment pollCount on all pending tasks for a thread. */
  incrementPendingTaskPollCount(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread?.pendingBackgroundTasks) return;
    for (const task of thread.pendingBackgroundTasks) {
      task.pollCount++;
    }
  }

  /**
   * Detect whether the message triggers Opus escalation. Returns the model
   * string to pass to ClaudeSession if escalation should occur, or undefined
   * if the default model should be used.
   */
  private resolveModel(userText: string): string | undefined {
    if (!this.settings.opusEscalationEnabled) return undefined;
    const keyword = (this.settings.opusEscalationKeyword ?? '/opus').trim();
    if (!keyword) return undefined;
    // Match keyword anywhere in the message (case-insensitive)
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i');
    return re.test(userText) ? 'opus' : undefined;
  }

  /**
   * Strip the escalation keyword from the message so it isn't passed to Claude verbatim.
   */
  private stripKeyword(userText: string): string {
    if (!this.settings.opusEscalationEnabled) return userText;
    const keyword = (this.settings.opusEscalationKeyword ?? '/opus').trim();
    if (!keyword) return userText;
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'gi');
    return userText.replace(re, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  async sendMessage(threadId: string, userText: string, images?: ImageAttachment[]): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    if (this.sessions.has(threadId)) {
      const queue = this.queuedMessages.get(threadId) ?? [];
      queue.push({ text: userText, images });
      this.queuedMessages.set(threadId, queue);
      this.emit(threadId, { type: 'queued', text: userText, images });
      return;
    }

    thread.lastError = undefined;
    thread.status = 'active';
    this.threadActivity.delete(threadId);

    const keywordModel = this.resolveModel(userText);
    const model = keywordModel ?? thread.model;
    const promptText = keywordModel ? this.stripKeyword(userText) : userText;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
      timestamp: Date.now(),
      images: images && images.length > 0 ? images : undefined,
    };
    thread.messages.push(userMsg);
    thread.updatedAt = Date.now();
    this.emit(threadId, { type: 'user_message_added', message: userMsg });

    const session = new ClaudeSession(this.settings.claudeBinaryPath);
    this.sessions.set(threadId, session);
    this.emit(threadId, { type: 'streaming_start' });

    if (model) {
      this.emit(threadId, { type: 'escalated', model });
    }

    let streamingContent = '';
    const pendingToolCalls: ToolCallRecord[] = [];
    let completedSuccessfully = false;
    // Track background tasks (skipTranscript tasks) that start but don't notify before session ends.
    const activeBgTasks = new Map<string, { description: string; startedAt: number }>();

    // Safety net against the misleading "binary not found" ENOENT the SDK emits
    // when Claude is spawned with a non-existent cwd.  repairStaleCwds() handles
    // volatile tmpdir worktrees at load time, but project-directory worktrees
    // (e.g. created by the release-manager under <repo>/worktrees/<branch>) are
    // outside that scope.  We catch all missing cwds here so every case gets a
    // clear error or an auto-repair instead of a cryptic spawn failure.
    if (thread.cwd) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      if (!fs.existsSync(thread.cwd)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodePath = require('path') as typeof import('path');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const os = require('os') as typeof import('os');
        const worktreeContainer = nodePath.join(os.tmpdir(), 'claude-worktrees');
        const isVolatileWorktree =
          thread.cwd.startsWith(worktreeContainer + nodePath.sep);

        if (isVolatileWorktree) {
          // Use the dedicated repair path for tmpdir worktrees.
          this.repairStaleCwds();
        } else {
          // Non-volatile path (e.g. a project-directory worktree or a deleted
          // folder).  Walk up to the nearest valid ancestor — same strategy as
          // repairStaleCwds() — and silently reroute the thread there.
          let fallback: string = thread.cwd;
          while (true) {
            const parent = nodePath.dirname(fallback);
            if (parent === fallback) { fallback = ''; break; }
            fallback = parent;
            if (fs.existsSync(fallback)) break;
          }
          if (!fallback || !fs.existsSync(fallback)) {
            fallback = this.vaultRoot || os.homedir();
          }
          console.warn(
            `[ClaudeThreads] Auto-repairing stale cwd for thread "${thread.title}": ` +
            `"${thread.cwd}" → "${fallback}"`,
          );
          this.setThreadCwd(threadId, fallback);
        }

        // If the cwd is still missing after attempted repair, surface a clear
        // error rather than letting Node emit the confusing ENOENT.
        if (!fs.existsSync(thread.cwd!)) {
          const err = new Error(
            `Working directory no longer exists: "${thread.cwd}". ` +
            `Use set_working_directory to point this thread at a valid path.`,
          );
          this.emit(threadId, { type: 'error', error: err });
          return;
        }
      }
    }

    // Snapshot the cwd at session start. If obsidian_set_working_directory fires
    // mid-session, thread.cwd changes but this value stays fixed. We use it in
    // onDone to decide whether the resulting sessionId is safe to resume.
    const cwdAtStart = thread.cwd;

    const additionalDirs = [...new Set([this.vaultRoot, thread.cwd].filter(Boolean))];
    const project = thread.projectId ? this.getProject(thread.projectId) : undefined;
    const envContext = buildEnvironmentSystemPrompt(
      this.vaultRoot,
      cwdAtStart,
      this.settings.vaultFolder,
      this.settings.saveThreadsToVault,
    );
    const projectDesc = project?.description?.trim();
    const appendSystemPrompt = projectDesc ? `${envContext}\n\n${projectDesc}` : envContext;
    const sessionMcpServers = this.mcpServerFactory ? this.mcpServerFactory(threadId, cwdAtStart) : this.mcpServers;
    const resolvedSecretEnv = this.secretEnvResolver ? this.secretEnvResolver() : {};

    // If there is no session to resume but there IS prior history, the cwd must
    // have changed mid-conversation (via obsidian_set_working_directory). Inject
    // the prior turns as a preamble so Claude isn't amnesiac after the switch.
    const priorMessages = thread.messages.slice(0, -1); // excludes the just-pushed user msg
    const effectivePrompt =
      !thread.sessionId && priorMessages.length > 0
        ? buildHistoryPreamble(priorMessages, cwdAtStart) + promptText
        : promptText;

    await session.run(
      effectivePrompt,
      thread.sessionId,
      cwdAtStart,
      this.settings.permissionMode,
      this.settings.extraEnv,
      {
        onToken: (text) => {
          streamingContent += text;
          this.emit(threadId, { type: 'token', text });
        },
        onToolUse: (record) => {
          pendingToolCalls.push(record);
          this.threadActivity.set(threadId, record.summary);
          // Persist file paths for Write/Edit tools so they survive tab switches.
          if (record.name === 'Write' || record.name === 'Edit') {
            const filePath = record.summary.replace(/^[^:]+: /, '');
            if (filePath) {
              if (!thread.editedFiles) thread.editedFiles = [];
              if (!thread.editedFiles.includes(filePath)) thread.editedFiles.push(filePath);
            }
          }
          this.emit(threadId, { type: 'tool_use', record });
        },
        onRecap: (summary) => {
          thread.recap = summary;
          this.emit(threadId, { type: 'recap', summary });
        },
        onMessage: (content, toolCalls) => {
          streamingContent = '';
          const assistantMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content,
            timestamp: Date.now(),
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          };
          thread.messages.push(assistantMsg);
          thread.updatedAt = Date.now();
          pendingToolCalls.length = 0;
          // Detect the most recent GitHub PR URL in assistant output so the
          // context footer can surface a clickable PR pill automatically.
          const prMatch = content.match(/https:\/\/github\.com\/[^\s>)"']+\/pull\/\d+/);
          if (prMatch) thread.prUrl = prMatch[0];
          this.emit(threadId, { type: 'message', message: assistantMsg });
        },
        onDone: (sessionId, cost) => {
          // Only save the session ID for resumption if cwd didn't change during
          // this run. If the directory changed (via obsidian_set_working_directory),
          // the session lives under the old project path and can't be resumed in
          // the new one — clearing it forces a fresh session next turn.
          if (thread.cwd === cwdAtStart) {
            thread.sessionId = sessionId;
          }
          thread.updatedAt = Date.now();
          thread.status = 'waiting';
          const lastMsg = thread.messages[thread.messages.length - 1];
          if (lastMsg?.role === 'assistant' && cost > 0) {
            lastMsg.cost = cost;
          }
          this.sessions.delete(threadId);
          this.threadActivity.delete(threadId);
          completedSuccessfully = true;

          // If any background tasks started but never notified, persist them so
          // main.ts can schedule polling resumption after the session closes.
          if (activeBgTasks.size > 0) {
            const newPending: PendingBackgroundTask[] = Array.from(activeBgTasks.entries()).map(
              ([taskId, { description, startedAt }]) => ({ taskId, description, startedAt, pollCount: 0 }),
            );
            // Merge with any already-persisted tasks (dedup by taskId).
            const existing = thread.pendingBackgroundTasks ?? [];
            const existingIds = new Set(existing.map(t => t.taskId));
            thread.pendingBackgroundTasks = [
              ...existing,
              ...newPending.filter(t => !existingIds.has(t.taskId)),
            ];
            this.emit(threadId, { type: 'background_tasks_pending', tasks: thread.pendingBackgroundTasks });
          }

          this.emit(threadId, { type: 'done' });
        },
        onInterrupted: (_sessionId) => {
          // Roll back the orphaned user message — it was never processed by Claude Code
          const lastMsg = thread.messages[thread.messages.length - 1];
          if (lastMsg && lastMsg.id === userMsg.id) {
            thread.messages.pop();
          }
          thread.updatedAt = Date.now();
          thread.status = 'waiting';
          // Do NOT update thread.sessionId — the last successful session ID is still valid
          this.sessions.delete(threadId);
          this.threadActivity.delete(threadId);
          this.queuedMessages.delete(threadId);
          // completedSuccessfully intentionally stays false
          this.emit(threadId, { type: 'interrupted' });
        },
        onError: (err) => {
          thread.lastError = err.message;
          thread.updatedAt = Date.now();
          thread.status = 'error';
          this.sessions.delete(threadId);
          this.threadActivity.delete(threadId);
          this.queuedMessages.delete(threadId);
          this.emit(threadId, { type: 'error', error: err });
        },
        onPermissionRequest: async (toolName, detail) => {
          this.pendingPermissions.set(threadId, { toolName, detail });
          this.emit(threadId, { type: 'permission_request', toolName, detail });
          try {
            return await this.permissionHandler(threadId, toolName, detail);
          } finally {
            this.pendingPermissions.delete(threadId);
            this.permissionResolvers.delete(threadId);
            this.emit(threadId, { type: 'permission_resolved' });
          }
        },
        onAskUserQuestion: (questions) => this.questionHandler(questions),
        onOpenNewTab: (title, initialPrompt) => this.openNewTabHandler(title, initialPrompt),
        onStatus: (status) => this.emit(threadId, { type: 'status', status }),
        onCompact: (trigger, preTokens) => {
          const compactMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'compact',
            content: '',
            timestamp: Date.now(),
            compactTrigger: trigger,
            preTokens,
          };
          thread.messages.push(compactMsg);
          thread.updatedAt = Date.now();
          this.emit(threadId, { type: 'compact', message: compactMsg });
        },
        onTaskStarted: (taskId, description, skipTranscript) => {
          this.threadActivity.set(threadId, description);
          // Background tasks use skipTranscript=true. Track them so we can detect
          // if they're still running when the session ends.
          if (skipTranscript) {
            activeBgTasks.set(taskId, { description, startedAt: Date.now() });
          }
          this.emit(threadId, { type: 'task_started', taskId, description, skipTranscript });
        },
        onTaskProgress: (taskId, description, lastToolName) => {
          const suffix = lastToolName ? ` · ${lastToolName}` : '';
          this.threadActivity.set(threadId, description + suffix);
          this.emit(threadId, { type: 'task_progress', taskId, description, lastToolName });
        },
        onTaskNotification: (taskId, status, summary) => {
          // Task resolved — remove from background tracking set.
          activeBgTasks.delete(taskId);
          // Also clear from persisted state (handles notifications that arrive
          // on a poll-resume after a previous session missed them).
          this.clearPendingBackgroundTask(threadId, taskId);
          this.emit(threadId, { type: 'task_notification', taskId, status, summary });
        },
        onNotification: (text, priority) => this.emit(threadId, { type: 'notification', text, priority }),
        onApiRetry: (attempt, maxRetries, error) => this.emit(threadId, { type: 'api_retry', attempt, maxRetries, error }),
        onRateLimit: (limitStatus, resetsAt) => this.emit(threadId, { type: 'rate_limit', limitStatus, resetsAt }),
      },
      additionalDirs,
      model,
      images,
      appendSystemPrompt,
      sessionMcpServers,
      resolvedSecretEnv,
    );

    if (completedSuccessfully) {
      const queue = this.queuedMessages.get(threadId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.queuedMessages.delete(threadId);
        this.emit(threadId, { type: 'dequeued', text: next.text, images: next.images });
        await this.sendMessage(threadId, next.text, next.images);
      }
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      await session.interrupt();
    }
  }

  subscribe(listener: ThreadStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyActiveThreadChanged(threadId: string): void {
    this.emit(threadId, { type: 'active_thread_changed' });
  }

  notifySummaryUpdated(threadId: string): void {
    this.emit(threadId, { type: 'summary_updated' });
  }

  private emit(threadId: string, event: ThreadEvent): void {
    for (const listener of this.listeners) {
      listener(threadId, event);
    }
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
  }
}

/**
 * Builds a text preamble that summarises prior conversation turns when session
 * continuity is lost (e.g. after a working-directory change). Capped at the
 * most recent 20 messages to avoid bloating the context window.
 */
function buildHistoryPreamble(priorMessages: ChatMessage[], newCwd: string): string {
  const MAX_MESSAGES = 20;
  const messages = priorMessages.length > MAX_MESSAGES
    ? priorMessages.slice(-MAX_MESSAGES)
    : priorMessages;

  const omitted = priorMessages.length - messages.length;
  const lines: string[] = [
    `[Note: the working directory was changed to ${newCwd} and the Claude Code session could not be resumed. The prior conversation is summarised below to restore context.]`,
    '',
  ];

  if (omitted > 0) {
    lines.push(`[... ${omitted} earlier message${omitted > 1 ? 's' : ''} omitted ...]`, '');
  }

  for (const msg of messages) {
    if (msg.role === 'compact') {
      lines.push('[— context compacted here —]', '');
      continue;
    }

    const label = msg.role === 'user' ? 'User' : 'Assistant';
    const toolSuffix =
      msg.toolCalls && msg.toolCalls.length > 0
        ? ` [used: ${msg.toolCalls.map(t => t.summary).join(', ')}]`
        : '';

    lines.push(`${label}: ${msg.content}${toolSuffix}`, '');
  }

  lines.push('[End of prior context. Continue from here.]', '');

  return lines.join('\n');
}

/**
 * Builds the base system-prompt context injected into every session.
 * Tells the agent where it is running, path semantics for Obsidian vs
 * filesystem tools, and key behavioral notes about session-affecting tools.
 */
function buildEnvironmentSystemPrompt(
  vaultRoot: string,
  cwd: string,
  vaultFolder: string,
  saveThreadsToVault: boolean,
): string {
  const lines = [
    'You are running inside the Obsidian Claude Threads plugin.',
    '',
    `Vault root (filesystem path): ${vaultRoot}`,
    `Working directory: ${cwd}`,
    '',
    'Path semantics:',
    '- obsidian_* tools use vault-relative paths (e.g. "Daily/2026-05-18.md")',
    '- Filesystem tools (Read, Write, Bash) use absolute paths',
  ];

  if (saveThreadsToVault) {
    lines.push(
      '',
      `Conversation history: completed threads are auto-saved as Markdown notes to "${vaultFolder}/YYYY-MM-DD-<title-slug>.md" in the vault. Use obsidian_search_vault or Read to look up prior conversations.`,
    );
  }

  lines.push(
    '',
    'Tool notes:',
    '- set_working_directory takes effect on the next turn and resets session continuity. Set it before starting a task, not mid-conversation.',
    '- enter_worktree / exit_worktree: use these instead of the built-in EnterWorktree/ExitWorktree tools. They read the effective cwd updated by set_working_directory, so they always target the right git repo.',
    '- ScheduleWakeup injects the given prompt as a new message into this thread after the delay.',
    '- obsidian_list_commands returns all registered Obsidian commands (id + name); pass a query to filter. Call this before obsidian_execute_command to look up the correct command ID.',
    '- obsidian_execute_command triggers any Obsidian command by ID — useful for vault-bridge sync, git push, toggling editor modes, etc.',
    '- obsidian_open_url opens a URL directly in the Obsidian Web Viewer panel (reuses an existing tab by default). Use this to open local dev servers, HTML files, or any web page without the user having to type the URL.',
  );

  return lines.join('\n');
}


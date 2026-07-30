import { ThreadSession, type SessionCallbacks, type TaskTrackerEvent, type ThreadSessionOptions } from './ThreadSession';
import { RawLogWriter } from './RawLogWriter';
import { effectiveExtraEnv } from './types';
import { derivePrUrl } from './statusLine';
import { debugLog } from './logger';
import type { Thread, ChatMessage, PluginSettings, ToolCallRecord, AskQuestion, ImageAttachment, Project, PendingBackgroundTask, TaskItem, TaskItemStatus, StatusTag, GitDiffInfo } from './types';
import type { McpServerConfig, SdkBeta, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

type ThreadStateListener = (threadId: string, event: ThreadEvent) => void;

export type ThreadEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_use'; record: ToolCallRecord }
  | { type: 'message'; message: ChatMessage }
  | { type: 'recap'; summary: string }
  | { type: 'done' }
  | { type: 'error'; error: Error }
  | { type: 'reconnecting'; error: string }
  | { type: 'streaming_start' }
  | { type: 'escalated'; model: string }
  | { type: 'queued'; text: string; images?: ImageAttachment[] }
  | { type: 'dequeued'; text: string; images?: ImageAttachment[] }
  | { type: 'status'; status: 'compacting' | 'requesting' | null }
  | { type: 'compact'; message: ChatMessage }
  | { type: 'task_started'; taskId: string; description: string; skipTranscript: boolean; taskType?: string; workflowName?: string; subagentType?: string }
  | { type: 'task_updated'; taskId: string; status?: string; description?: string; error?: string }
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
  | { type: 'summary_updated' }
  | { type: 'tool_result_images'; images: Array<{ mediaType: string; data: string }> }
  | { type: 'tasks_updated'; tasks: TaskItem[] }
  | { type: 'wakeup_changed' }
  | { type: 'manager_notes_changed' }
  | { type: 'proposed_reply_changed' }
  | { type: 'run_state_settled' }
  | { type: 'status_tags' }
  | { type: 'git_diff' }
  | { type: 'model_fallback'; trigger: string; fromModel: string; toModel: string }
  | { type: 'tool_progress'; toolUseId: string; toolName: string; elapsedSeconds: number }
  | { type: 'memory_recall'; paths: string[]; mode: 'select' | 'synthesize' }
  | { type: 'commands_changed'; commands: import('@anthropic-ai/claude-agent-sdk').SlashCommand[] }
  | { type: 'task_progress_summary'; taskId: string; summary: string }
  | { type: 'git_operation'; summary: string }
  | { type: 'file_user_modified'; filePath: string }
  | { type: 'tool_result_status'; toolUseId: string; status: 'success' | 'error'; durationMs?: number }
  | { type: 'enter_plan_mode' }
  | { type: 'plan_ready'; planText: string; approve: (editedPlan?: string) => void; reject: () => void }
  | { type: 'pending_plan_changed'; planText: string | undefined }
  | { type: 'question_ready'; questions: AskQuestion[] }
  | { type: 'pending_question_changed'; questions: AskQuestion[] | undefined }
  | { type: 'capabilities_discovered'; models: import('@anthropic-ai/claude-agent-sdk').ModelInfo[]; agents: import('@anthropic-ai/claude-agent-sdk').AgentInfo[] }
  | { type: 'elicitation_request'; request: import('@anthropic-ai/claude-agent-sdk').ElicitationRequest; signal: AbortSignal; respond: (result: import('@anthropic-ai/claude-agent-sdk').ElicitationResult) => void };

/**
 * Parse an agent definition markdown file (frontmatter + body).
 * Frontmatter fields: name, description (plain or YAML >- block scalar).
 * Body (after the closing ---) becomes the system prompt.
 */
function parseAgentMarkdown(content: string): { name?: string; description?: string; prompt?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return {};
  const fm = match[1];
  const prompt = match[2].trim();

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim();

  // Handle both inline (description: text) and block scalar (description: >-\n  line...)
  let description: string | undefined;
  const blockMatch = fm.match(/^description:\s*>[-]?\r?\n((?:[ \t]+[^\r\n]*\r?\n?)+)/m);
  if (blockMatch) {
    description = blockMatch[1]
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .join(' ');
  } else {
    const inlineMatch = fm.match(/^description:\s*(.+)$/m);
    description = inlineMatch?.[1]?.trim();
  }

  return { name, description, prompt: prompt || undefined };
}

export class ThreadManager {
  private threads: Map<string, Thread> = new Map();
  private projects: Map<string, Project> = new Map();
  /**
   * One long-lived `ThreadSession` per thread (ADR-0002 §2), lazily created
   * on the thread's first message and reused across every subsequent turn.
   * Replaces the old `sessions` (turn in flight) + `lingeringSessions`
   * (result landed but a background task still streaming a further
   * generation) two-map model — there is only ever one `Query` per thread
   * now, so there is nothing for a second session to race for its stdin.
   * An entry here means the thread has a live subprocess; it stays in the
   * map (idle or busy) until the thread is deleted or the plugin shuts
   * down — `session.turnInFlight` (see `isRunning()`) is what distinguishes
   * "busy right now" from "warm but idle."
   */
  private sessions: Map<string, ThreadSession> = new Map();
  /**
   * Per-thread accumulator for inline images returned by a tool result,
   * flushed onto the next assistant message. Previously a local variable
   * scoped to one `sendMessage()`/`ClaudeSession.run()` call; now instance
   * state because `SessionCallbacks` are built once per `ThreadSession`
   * (`start()`/`restart()`) and reused across every turn of that session,
   * not rebuilt per turn.
   */
  private pendingToolResultImages: Map<string, Array<{ mediaType: string; data: string }>> = new Map();
  /**
   * Per-thread tracking of background (skipTranscript) tasks that have
   * started but not yet notified completion, so `onDone` can persist them to
   * `thread.pendingBackgroundTasks` for polling resumption. Same rationale
   * as `pendingToolResultImages` above — moved from a per-turn local to
   * instance state now that callbacks outlive a single turn.
   */
  private activeBgTasks: Map<string, Map<string, { description: string; startedAt: number }>> = new Map();
  /**
   * IDs of user messages pushed to `thread.messages` since the last settled
   * generation (onDone/onInterrupted/onError) for this thread. Under the old
   * per-turn model, `onInterrupted` only ever needed to roll back the single
   * `userMsg` pushed by that turn's own `sendMessage()` call, matched by
   * exact id. Under ADR-0002 §2's confirmed always-safe-to-send() model,
   * `sendMessage()` no longer gates on "busy," so a follow-up (or a second,
   * third, ...) user message can land — and get pushed to `thread.messages`
   * — before a single generation's `result`/interrupt settles it. If an
   * interrupt then lands, ALL of those unresolved messages need to be
   * rolled back, not just the last one, or an earlier one is left sitting
   * in the transcript looking like it was successfully sent and answered
   * when it was never actually processed.
   */
  private pendingUserMessageIds: Map<string, string[]> = new Map();
  private queuedMessages: Map<string, { text: string; images?: ImageAttachment[] }[]> = new Map();
  private threadActivity: Map<string, string> = new Map();
  private pendingPermissions: Map<string, { toolName: string; detail: string }> = new Map();
  private permissionResolvers: Map<string, (allow: boolean) => void> = new Map();
  /**
   * In-memory store for pending AskUserQuestion answer resolvers, keyed by
   * thread ID. Mirrors `permissionResolvers` — the *state* (the questions
   * themselves) is persisted on `thread.pendingQuestions` like `pendingPlan`,
   * but the live resolver can only exist while the session is actively
   * awaiting the answer. `hasPendingQuestion` is keyed off this map's
   * presence rather than a parallel state map, since the question content
   * itself already lives on `thread.pendingQuestions`.
   */
  private pendingQuestionResolvers: Map<string, (answers: Record<string, string>) => void> = new Map();
  /** Remote permission resolvers keyed by requestId (used by RelayClient). */
  private remotePermissionResolvers: Map<string, (allow: boolean) => void> = new Map();
  /** Remote question resolvers keyed by requestId (used by RelayClient). */
  private remoteQuestionResolvers: Map<string, (answers: Record<string, string>) => void> = new Map();
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
  questionHandler: (threadId: string, questions: AskQuestion[]) => Promise<Record<string, string>> = async () => ({});
  openNewTabHandler: (title?: string, initialPrompt?: string) => Promise<{ threadId: string; title: string }> = async (title) => ({ threadId: '', title: title ?? 'New Thread' });
  vaultRoot = '';
  /**
   * Absolute filesystem path to this plugin's installed directory (vaultRoot +
   * manifest.dir), set once from main.ts alongside vaultRoot. Used to resolve
   * the bundled thread-orchestrator skill at <pluginResourceDir>/resources/skills/
   * so it can be registered as a local SDK plugin without any manual install
   * into ~/.claude/skills/. Empty until main.ts sets it (e.g. in tests).
   */
  pluginResourceDir = '';
  /**
   * In-memory store for the live approve/reject callbacks from a plan_ready event.
   * Keyed by thread ID. NOT serialized to JSON — only set while the session is
   * actively waiting for the user to act on the plan card.
   */
  private pendingPlanResolvers: Map<string, { approve: (edited?: string) => void; reject: () => void }> = new Map();
  /** Appends each thread's raw SDK event stream to a per-thread JSONL log. */
  private rawLogWriter: RawLogWriter;

  constructor(settings: PluginSettings) {
    this.settings = settings;
    this.rawLogWriter = new RawLogWriter(
      () => this.vaultRoot,
      () => this.settings.vaultFolder,
    );
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  /**
   * Reads parsed entries from a thread's raw JSONL log. Filters by `type` then
   * tails to the most recent `limit` entries. Returns null if no log exists.
   */
  readRawLog(
    threadId: string,
    opts?: { limit?: number; type?: string },
  ): Promise<{ path: string; total: number; returned: number; entries: unknown[] } | null> {
    return this.rawLogWriter.read(threadId, opts);
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
    this.pendingToolResultImages.delete(id);
    this.activeBgTasks.delete(id);
    this.pendingUserMessageIds.delete(id);
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

      // ADR-0002 §2: a cwd change is session-breaking (a resumed session
      // can't cross Claude Code project directories — the comment above
      // already establishes that). Previously this was an *implicit*
      // consequence of the next `sendMessage()` building a fresh, unresumed
      // `ClaudeSession`. With a long-lived `ThreadSession`, that has to be
      // made explicit: force an immediate close()+start() (no resume, and
      // rebuilt with the new cwd/MCP servers/system prompt) rather than
      // leaving the live Query pointed at the old directory until the next
      // turn happens to notice.
      const session = this.sessions.get(id);
      if (session) {
        const options = this.buildThreadSessionOptions(id, thread);
        if (options) {
          session.restart('cwd-change', options).catch((err) => {
            console.error('[ClaudeThreads] setThreadCwd: session restart failed:', err);
          });
        }
      }
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
      // ADR-0002 §2: model changes become a direct control-request on the
      // live Query instead of waiting for the next turn to rebuild Options.
      // If the session hasn't finished start()-ing yet, swallow the error —
      // the persisted thread.model above is already correct and will be
      // picked up whenever start() actually runs.
      const session = this.sessions.get(id);
      if (session) {
        session.setModel(model).catch((err) => {
          console.error('[ClaudeThreads] setThreadModel: live setModel() failed:', err);
        });
      }
    }
  }

  setThreadPendingPlan(id: string, planText: string | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      if (planText !== undefined) thread.pendingPlan = planText;
      else delete thread.pendingPlan;
      thread.updatedAt = Date.now();
    }
  }

  /** Returns the live approve/reject callbacks if a plan is actively awaiting user action. */
  getPendingPlanResolvers(id: string): { approve: (edited?: string) => void; reject: () => void } | undefined {
    return this.pendingPlanResolvers.get(id);
  }

  setThreadPendingQuestions(id: string, questions: AskQuestion[] | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      if (questions !== undefined) thread.pendingQuestions = questions;
      else delete thread.pendingQuestions;
      thread.updatedAt = Date.now();
    }
  }

  setThreadPermissionMode(id: string, mode: PluginSettings['permissionMode'] | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      if (mode !== undefined) thread.permissionMode = mode;
      else delete thread.permissionMode;
      thread.updatedAt = Date.now();
      // ADR-0002 §2: same rationale as setThreadModel() above — a direct
      // control-request on the live Query, no restart needed.
      const session = this.sessions.get(id);
      if (session) {
        const effectiveMode = mode ?? this.settings.permissionMode;
        session.setPermissionMode(effectiveMode as PermissionMode).catch((err) => {
          console.error('[ClaudeThreads] setThreadPermissionMode: live setPermissionMode() failed:', err);
        });
      }
    }
  }

  /** Set or clear (pass undefined) the persistent goal for a thread. */
  setThreadGoal(id: string, goal: string | undefined): void {
    const thread = this.threads.get(id);
    if (thread) {
      if (goal) thread.goal = goal;
      else delete thread.goal;
      thread.updatedAt = Date.now();
    }
  }

  /** ADR-0002 §2: a simple event-derived boolean off the single session map — no second map to check. */
  isRunning(id: string): boolean {
    return this.sessions.get(id)?.turnInFlight ?? false;
  }

  /**
   * Returns all threads that currently have a live `ThreadSession` (busy or
   * idle-but-warm). Used by the safe-reload guard to enumerate what would be
   * killed — under the long-lived-session model, any entry in `sessions` is
   * a real subprocess, not just threads with a turn in flight right now.
   */
  getRunningThreads(): Thread[] {
    return this.getThreads().filter((t) => this.sessions.has(t.id));
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

  hasPendingQuestion(threadId: string): boolean {
    return this.pendingQuestionResolvers.has(threadId);
  }

  registerQuestionResolver(threadId: string, resolver: (answers: Record<string, string>) => void): void {
    this.pendingQuestionResolvers.set(threadId, resolver);
  }

  /** Safe no-op if no resolver is currently registered for this thread. */
  resolveQuestion(threadId: string, answers: Record<string, string>): void {
    const resolver = this.pendingQuestionResolvers.get(threadId);
    if (resolver) resolver(answers);
  }

  /** Returns the live answer resolver if a question is actively awaiting user action. */
  getPendingQuestionResolver(threadId: string): ((answers: Record<string, string>) => void) | undefined {
    return this.pendingQuestionResolvers.get(threadId);
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

  /**
   * Resolve a question that was issued with a specific requestId (used by
   * RelayClient for remote question resolution from a mobile client).
   */
  resolveQuestionByRequestId(requestId: string, answers: Record<string, string>): void {
    const resolver = this.remoteQuestionResolvers.get(requestId);
    if (resolver) {
      this.remoteQuestionResolvers.delete(requestId);
      resolver(answers);
    }
  }

  /**
   * Register a resolver keyed by a stable requestId so that RelayClient can
   * bridge remote resolve_question commands to the correct local promise.
   */
  registerRemoteQuestionResolver(requestId: string, resolver: (answers: Record<string, string>) => void): void {
    this.remoteQuestionResolvers.set(requestId, resolver);
  }

  getQueuedMessage(id: string): string | undefined {
    const queue = this.queuedMessages.get(id);
    return queue && queue.length > 0 ? queue[0].text : undefined;
  }

  getQueuedMessages(id: string): { text: string; images?: ImageAttachment[] }[] {
    return this.queuedMessages.get(id) ?? [];
  }

  getQueuedCount(id: string): number {
    return this.queuedMessages.get(id)?.length ?? 0;
  }

  removeQueuedMessageAt(id: string, index: number): void {
    const queue = this.queuedMessages.get(id);
    if (!queue || index < 0 || index >= queue.length) return;
    queue.splice(index, 1);
    if (queue.length === 0) this.queuedMessages.delete(id);
  }

  getThreadActivity(id: string): string | undefined {
    return this.threadActivity.get(id);
  }

  /**
   * Store status-line tags for a thread (from StatusLineService) and derive its
   * prUrl. prUrl is STICKY: only overwritten when the tags yield a PR url, never
   * cleared on absence — so the release archive-on-merge workflow can still match
   * a thread after its PR merges. Emits `status_tags` so views re-render.
   * Returns true if prUrl changed (so the caller can decide to persist).
   */
  applyStatusTags(threadId: string, tags: StatusTag[]): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) return false;
    thread.statusTags = tags;
    const pr = derivePrUrl(tags);
    let prChanged = false;
    if (pr && pr !== thread.prUrl) {
      thread.prUrl = pr;
      prChanged = true;
    }
    this.emit(threadId, { type: 'status_tags' });
    return prChanged;
  }


  /**
   * Store native git plumbing info for a thread (from GitDiffService) and emit
   * `git_diff` so views re-render the git diff bar. Ephemeral like statusTags —
   * not persisted, re-derived on the next poll.
   */
  applyGitDiff(threadId: string, info: GitDiffInfo): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.gitDiff = info;
    this.emit(threadId, { type: 'git_diff' });
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
   * Detect whether the message triggers model escalation. Returns the model
   * string to use for this turn if escalation should occur, or undefined
   * if the default model should be used.
   */
  private resolveModel(userText: string): string | undefined {
    if (!this.settings.escalationEnabled) return undefined;
    const keyword = (this.settings.escalationKeyword ?? '/escalate').trim();
    if (!keyword) return undefined;
    // Match keyword anywhere in the message (case-insensitive)
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i');
    return re.test(userText) ? (this.settings.escalationModel || 'opus') : undefined;
  }

  /**
   * Strip the escalation keyword from the message so it isn't passed to Claude verbatim.
   */
  private stripKeyword(userText: string): string {
    if (!this.settings.escalationEnabled) return userText;
    const keyword = (this.settings.escalationKeyword ?? '/escalate').trim();
    if (!keyword) return userText;
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'gi');
    return userText.replace(re, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  async sendMessage(threadId: string, userText: string, images?: ImageAttachment[]): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    thread.lastError = undefined;
    thread.status = 'active';
    this.threadActivity.delete(threadId);

    const keywordModel = this.resolveModel(userText);
    // Precedence: escalation keyword > per-thread /model override > settings default
    const model = keywordModel ?? thread.model ?? (this.settings.defaultModel || undefined);
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

    // Track this message as unresolved until the generation it lands in
    // settles (onDone/onInterrupted/onError) — see pendingUserMessageIds'
    // doc comment. Multiple ids can accumulate here across concurrent
    // sendMessage() calls now that there's no "busy" gate.
    const pendingIds = this.pendingUserMessageIds.get(threadId) ?? [];
    pendingIds.push(userMsg.id);
    this.pendingUserMessageIds.set(threadId, pendingIds);

    // Get-or-lazily-create this thread's ThreadSession (ADR-0002 §3: lazy on
    // first message, reused for every subsequent turn — replaces `new
    // ClaudeSession()` per turn). IMPORTANT: this lookup-or-create is
    // synchronous, with no `await` before `this.sessions.set()` below — two
    // concurrent sendMessage() calls for the same thread can never both
    // observe "no session yet," because JS run-to-completion semantics mean
    // the first call's synchronous prefix (including the `.set()`) always
    // finishes before the second call's synchronous prefix starts, so the
    // second call sees the first call's session already in the map. That
    // closes the exact race this ADR exists to remove, without needing the
    // old `if (this.sessions.has(threadId)) { queue; return; }` gate — which
    // is also why that gate is gone entirely: ADR-0002 §2's live-CLI probe
    // confirmed `send()` is safe to call unconditionally even while a turn
    // is already in flight (the CLI coalesces it into the current
    // generation), so there's no need to hold messages back locally anymore.
    let session = this.sessions.get(threadId);
    const isNewSession = !session;
    if (!session) {
      session = new ThreadSession(this.settings.claudeBinaryPath);
      this.sessions.set(threadId, session);
    }

    this.emit(threadId, { type: 'streaming_start' });
    if (model) {
      this.emit(threadId, { type: 'escalated', model });
    }

    // Safety net against the misleading "binary not found" ENOENT the SDK
    // emits when Claude is spawned with a non-existent cwd — see
    // ensureCwdExists() for the repair strategy. Bail out (an 'error' event
    // has already been emitted) if the cwd is still missing afterward.
    const options = this.buildThreadSessionOptions(threadId, thread);
    if (!options) return;

    // If there is no session to resume but there IS prior history, the cwd must
    // have changed mid-conversation (via obsidian_set_working_directory). Inject
    // the prior turns as a preamble so Claude isn't amnesiac after the switch.
    const priorMessages = thread.messages.slice(0, -1); // excludes the just-pushed user msg
    const isFreshUnresumedSession = !thread.sessionId && priorMessages.length > 0;
    const effectivePrompt = isFreshUnresumedSession
      ? buildHistoryPreamble(priorMessages, thread.cwd) + promptText
      : promptText;

    // The SDK's Task board IDs are small integers that restart at 1 for every
    // new session (~/.claude/tasks/<session-uuid>/1.json, 2.json, ...). Once we
    // start a brand-new session here — rather than resuming the prior one —
    // any tasks left over on this thread belong to a session that's gone for
    // good. Leaving them in place means the new session's TaskCreate calls
    // collide by ID with these stale entries: applyTaskEvent() upserts by raw
    // ID, so a leftover incomplete task silently gets its content overwritten
    // and flipped to whatever status the new session's same-ID task reaches.
    // Clear both so the new session starts with a clean board.
    if (isFreshUnresumedSession) {
      delete thread.tasks;
      delete thread.pendingBackgroundTasks;
      this.emit(threadId, { type: 'tasks_updated', tasks: [] });
    }

    if (isNewSession) {
      await session.start(options);
    } else {
      // ADR-0002 §2: model/permission-mode changes are a direct
      // control-request on the live Query instead of a full session
      // rebuild. Resync on every turn (not just when setThreadModel()/
      // setThreadPermissionMode() are explicitly called) so the transient
      // /escalate keyword keeps working — it was always a per-run()
      // override before; applying it for this turn and leaving it in
      // effect until a future turn resolves a different model is the
      // closest equivalent under a persistent Query.
      try {
        await session.setModel(model);
        await session.setPermissionMode(options.permissionMode as PermissionMode);
      } catch (err) {
        console.error('[ClaudeThreads] sendMessage: failed to sync model/permission mode before send:', err);
      }
    }

    try {
      session.send(effectivePrompt, images);
    } catch (err) {
      // The ThreadSession's Query had already been torn down (a prior
      // generation errored out, or the channel was otherwise closed) —
      // restart it in place (resuming thread.sessionId, same as a lazy
      // first start) and retry once. Unlike the old per-turn ClaudeSession,
      // a closed ThreadSession is reopened on the SAME instance rather than
      // raced against a second one (ADR-0002 §2).
      console.warn('[ClaudeThreads] sendMessage: send() on a closed ThreadSession — restarting:', err);
      await session.start(options);
      session.send(effectivePrompt, images);
    }
  }

  /**
   * Checks (and best-effort repairs) a thread's cwd before opening or
   * restarting its `ThreadSession`. Moved out of `sendMessage()` so
   * `setThreadCwd()`'s restart path (via `buildThreadSessionOptions()`
   * below) can share it. Returns false — having already emitted an 'error'
   * event — if the cwd is still missing after an attempted repair.
   */
  private ensureCwdExists(threadId: string, thread: Thread): boolean {
    if (!thread.cwd) return true;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    if (fs.existsSync(thread.cwd)) return true;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    const worktreeContainer = nodePath.join(os.tmpdir(), 'claude-worktrees');
    const isVolatileWorktree = thread.cwd.startsWith(worktreeContainer + nodePath.sep);

    if (isVolatileWorktree) {
      // Use the dedicated repair path for tmpdir worktrees.
      this.repairStaleCwds();
    } else {
      // Non-volatile path (e.g. a project-directory worktree or a deleted
      // folder). Walk up to the nearest valid ancestor — same strategy as
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
      return false;
    }
    return true;
  }

  /**
   * Builds the full options needed to open (or restart) a thread's
   * `ThreadSession`: cwd validation/repair, additional directories, the
   * per-thread system-prompt context, MCP servers, secret env, and the
   * `SessionCallbacks` that wire the session's message pump back into
   * `ThreadEvent`s. Called both from `sendMessage()` (lazy first start) and
   * `setThreadCwd()` (explicit cwd-change restart, ADR-0002 §2). Returns
   * null if the thread's cwd is missing and couldn't be repaired (an
   * 'error' event has already been emitted in that case).
   */
  private buildThreadSessionOptions(threadId: string, thread: Thread): ThreadSessionOptions | null {
    if (!this.ensureCwdExists(threadId, thread)) return null;

    const additionalDirs = [...new Set([this.vaultRoot, thread.cwd].filter(Boolean))];
    const project = thread.projectId ? this.getProject(thread.projectId) : undefined;
    const envContext = buildEnvironmentSystemPrompt(
      this.vaultRoot,
      thread.cwd,
      this.settings.vaultFolder,
      this.settings.saveThreadsToVault,
    );
    const projectDesc = project?.description?.trim();
    const goalContext = thread.goal
      ? `## Active Goal\nThe user has set a persistent goal for this thread: "${thread.goal}"\n` +
        'Keep working toward this goal across turns. If a reply would leave the goal unmet, ' +
        'state what remains and continue working on it. The goal stays active until the user clears it with /goal clear.'
      : '';
    // INTENTIONAL: thread.managerNotes and thread.proposedReply are never included
    // here. They are thread-orchestrator bookkeeping (inferred goal/status/cursor,
    // a drafted-but-unsent reply) meant to be visible only in the UI. Unlike
    // `goal` below — which the user explicitly asks to be injected into every
    // turn — leaking these into the session context would let the model see
    // its own prior "grading" of the thread and the orchestrator's draft before
    // Rick has approved it. Do not "fix" this by adding them to the list.
    const appendSystemPrompt = [envContext, projectDesc, goalContext]
      .filter(Boolean)
      .join('\n\n');
    const sessionMcpServers = this.mcpServerFactory ? this.mcpServerFactory(threadId, thread.cwd) : this.mcpServers;
    const resolvedSecretEnv = this.secretEnvResolver ? this.secretEnvResolver() : {};

    return {
      claudePath: this.settings.claudeBinaryPath,
      cwd: thread.cwd,
      permissionMode: thread.permissionMode ?? this.settings.permissionMode,
      extraEnvRaw: effectiveExtraEnv(this.settings),
      resume: thread.sessionId,
      callbacks: this.buildSessionCallbacks(threadId, thread),
      additionalDirectories: additionalDirs,
      model: thread.model ?? (this.settings.defaultModel || undefined),
      appendSystemPrompt,
      mcpServers: sessionMcpServers,
      secretEnv: resolvedSecretEnv,
      disallowedTools: this.settings.disallowedTools,
      sessionOptions: this.buildSessionOptions(thread),
    };
  }

  /**
   * Clears the transient `'reconnecting'` status set by `onReconnecting`
   * (see below) once the auto-retried continuation turn actually starts
   * producing events again. Under the old per-turn model, this reset
   * happened implicitly: the continuation was a brand-new `sendMessage()`
   * call, which sets `thread.status = 'active'` at its own top (`:738`).
   * Under the new long-lived-`ThreadSession` model there is no such call —
   * `ThreadSession.pumpMessages()`'s catch block calls `this.send(...)`
   * internally, with no `sendMessage()`/`ThreadManager` round-trip at all —
   * so nothing would otherwise clear `'reconnecting'` if the continuation
   * succeeds.
   *
   * Called from whichever of `onToken`/`onMessage`/`onStatus` fires first
   * once the continuation's generation resumes producing events, mirroring
   * the existing pattern elsewhere in this file of guarding a state
   * transition with "if it's currently in the state I'm about to leave"
   * (e.g. the `pendingPlan`/`pendingQuestions` safety nets in `onDone`/
   * `onError` below) rather than introducing a new dedicated signal from
   * `ThreadSession`. `onToken` is expected to fire first in the common case
   * (`includePartialMessages: true` streams text deltas before the final
   * `assistant` message), but a continuation whose first action is a tool
   * call with no preceding text would skip straight to `onMessage` (or, for
   * a `compacting`/`requesting` status flip mid-continuation, `onStatus`) —
   * covering all three is what actually guarantees the thread never gets
   * stuck showing `'reconnecting'` forever once real progress resumes,
   * regardless of what shape that progress takes.
   *
   * Deliberately NOT cleared in `onDone`/`onInterrupted`/`onError`: those
   * already unconditionally set `thread.status` to `'waiting'`/`'waiting'`/
   * `'error'` respectively, so a reconnecting thread that settles without
   * ever producing a visible event (unlikely, but not impossible) still
   * ends up in a correct terminal status without needing this helper too.
   */
  private clearReconnectingStatus(thread: Thread): void {
    if (thread.status === 'reconnecting') {
      thread.status = 'active';
      thread.updatedAt = Date.now();
    }
  }

  /**
   * Builds the `SessionCallbacks` that wire a `ThreadSession`'s message pump
   * back into `ThreadEvent`s for this thread. Built once per `start()`/
   * `restart()` call — NOT once per turn, unlike the old per-turn
   * `ClaudeSession`'s callback object. Per-turn accumulation that used to
   * live in local variables scoped to one `sendMessage()` call (tool-result
   * images, in-flight background tasks) now lives in instance state
   * (`pendingToolResultImages`, `activeBgTasks`) keyed by threadId, since
   * these callbacks are reused across every turn of the thread's session.
   */
  private buildSessionCallbacks(threadId: string, thread: Thread): SessionCallbacks {
    return {
      onRawEvent: (event) => {
        if (!this.settings.saveRawLogs || !this.vaultRoot) return;
        // Record the log path on the thread the first time we write, so the
        // markdown note's `raw_log` frontmatter can link to it.
        if (!thread.rawLogPath) {
          thread.rawLogPath = this.rawLogWriter.vaultRelativePath(thread.id);
        }
        this.rawLogWriter.append(
          thread.id,
          thread.sessionId,
          typeof event.type === 'string' ? event.type : 'unknown',
          event,
        );
      },
      onToken: (text) => {
        this.clearReconnectingStatus(thread);
        this.emit(threadId, { type: 'token', text });
      },
      onToolUse: (record) => {
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
        this.clearReconnectingStatus(thread);
        const images = this.pendingToolResultImages.get(threadId);
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          timestamp: Date.now(),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          toolResultImages: images && images.length > 0 ? [...images] : undefined,
        };
        this.pendingToolResultImages.delete(threadId);
        thread.messages.push(assistantMsg);
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'message', message: assistantMsg });
      },
      onDone: (sessionId, cost) => {
        // Under the old per-turn model, a `thread.cwd === cwdAtStart` check
        // guarded against a race where obsidian_set_working_directory
        // changed the cwd mid-run and this generation's sessionId belonged
        // to the old directory. That race can't happen anymore:
        // setThreadCwd() now immediately restart()s the live Query on a cwd
        // change (ADR-0002 §2), so by the time any onDone fires, the
        // session it belongs to was already opened against the current
        // thread.cwd.
        thread.sessionId = sessionId;
        thread.updatedAt = Date.now();
        thread.status = 'waiting';
        thread.streamCloseRetryCount = 0; // TODO: likely vestigial post-Stage-C — see types.ts's doc comment on this field
        const lastMsg = thread.messages[thread.messages.length - 1];
        if (lastMsg?.role === 'assistant' && cost > 0) {
          lastMsg.cost = cost;
        }
        this.threadActivity.delete(threadId);
        // This generation settled successfully — every user message pushed
        // since the last settlement (including any that coalesced into this
        // same generation per ADR-0002 §2) has now been answered. Nothing to
        // roll back, just stop tracking them.
        this.pendingUserMessageIds.delete(threadId);

        // Safety net: if a pending plan somehow survived to onDone (e.g. the
        // session completed without user action), clear it so a stale card
        // can't reappear on the next focus.
        if (thread.pendingPlan) {
          delete thread.pendingPlan;
          this.pendingPlanResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
        }

        // Same safety net for a dangling pending question.
        if (thread.pendingQuestions) {
          delete thread.pendingQuestions;
          this.pendingQuestionResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_question_changed', questions: undefined });
        }

        // If any background tasks started but never notified, persist them so
        // main.ts can schedule polling resumption after the session closes.
        const activeBgTasksForThread = this.activeBgTasks.get(threadId);
        if (activeBgTasksForThread && activeBgTasksForThread.size > 0) {
          const newPending: PendingBackgroundTask[] = Array.from(activeBgTasksForThread.entries()).map(
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
        this.emitRunStateSettledWhenIdle(threadId);
      },
      onInterrupted: (_sessionId) => {
        // Roll back every orphaned, unresolved user message — not just the
        // trailing one. Under the old per-turn model, sendMessage() gated on
        // "busy," so at most one user message could ever be unresolved when
        // an interrupt landed, and matching its exact userMsg.id (captured
        // in that turn's own closure) was enough. Under ADR-0002 §2's
        // confirmed always-safe-to-send() model there's no such gate: a
        // follow-up (or several) can be pushed to thread.messages while a
        // prior generation is still in flight and coalesce into it (or land
        // just before the interrupt), so more than one trailing message can
        // be unresolved at once. pendingUserMessageIds tracks every id
        // pushed since the last settlement, so roll back all of them — not
        // just the last — or an earlier one is left in the transcript
        // looking answered when it never was.
        const pendingIds = this.pendingUserMessageIds.get(threadId);
        if (pendingIds && pendingIds.length > 0) {
          const idSet = new Set(pendingIds);
          thread.messages = thread.messages.filter((m) => !idSet.has(m.id));
        }
        this.pendingUserMessageIds.delete(threadId);
        thread.updatedAt = Date.now();
        thread.status = 'waiting';
        // Do NOT update thread.sessionId — the last successful session ID is still valid
        this.threadActivity.delete(threadId);
        this.queuedMessages.delete(threadId);
        this.emit(threadId, { type: 'interrupted' });
        this.emitRunStateSettledWhenIdle(threadId);
      },
      onError: (err) => {
        // Safety net: always clean up a pending plan card here, mirroring
        // the onDone safety net above — otherwise an errored session (e.g.
        // during a long ExitPlanMode wait) leaves the card stuck forever
        // and its resolvers leak, since they resolve a promise for a
        // session that has already exited.
        if (thread.pendingPlan) {
          delete thread.pendingPlan;
          this.pendingPlanResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
        }

        // Transport-error auto-retry is now entirely ThreadSession's job
        // (ADR-0002 §2: "process died → respawn with resume" becomes
        // `session.restart('transport-error')`, handled internally in
        // ThreadSession's pump loop before this callback is ever reached —
        // see the `catch` block in `ThreadSession.pumpMessages()`). By the
        // time onError fires here, ThreadSession has already either
        // exhausted its own one-shot retry budget or determined the error
        // isn't transport-related — either way it's terminal from
        // ThreadManager's perspective, so there is no longer a second
        // retry-and-requeue branch here.
        thread.updatedAt = Date.now();
        thread.lastError = err.message;
        thread.status = 'error';
        thread.streamCloseRetryCount = 0; // TODO: likely vestigial post-Stage-C — see types.ts's doc comment on this field
        this.threadActivity.delete(threadId);
        this.queuedMessages.delete(threadId);
        // Terminal, like onDone — stop tracking these ids as unresolved.
        // Unlike onInterrupted, an error doesn't roll the messages back
        // (matches the pre-existing behavior: only an explicit interrupt
        // ever popped messages).
        this.pendingUserMessageIds.delete(threadId);
        this.emit(threadId, { type: 'error', error: err });
        this.emitRunStateSettledWhenIdle(threadId);
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
      onAskUserQuestion: async (questions) => {
        // Persist the question set so the card can be restored after a
        // reload/crash OR after the user switches threads mid-session,
        // mirroring the pendingPlan pattern.
        thread.pendingQuestions = questions;
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'pending_question_changed', questions });
        this.emit(threadId, { type: 'question_ready', questions });
        try {
          return await this.questionHandler(threadId, questions);
        } finally {
          delete thread.pendingQuestions;
          thread.updatedAt = Date.now();
          this.pendingQuestionResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_question_changed', questions: undefined });
        }
      },
      onOpenNewTab: (title, initialPrompt) => this.openNewTabHandler(title, initialPrompt),
      onStatus: (status) => {
        this.clearReconnectingStatus(thread);
        this.emit(threadId, { type: 'status', status });
      },
      onReconnecting: (error) => {
        // Mirrors the old per-turn model's ThreadManager.sendMessage()
        // onError branch (see ClaudeSession.ts's SessionCallbacks.onReconnecting
        // doc comment) as closely as possible: mark the thread as
        // reconnecting and emit the same 'reconnecting' event the UI
        // (ThreadsView.ts's `case 'reconnecting':`) already knows how to
        // render. Cleared by clearReconnectingStatus() once the internally
        // auto-retried continuation turn actually starts producing events
        // again (see that method's doc comment for why onDone/onError don't
        // also need to clear it).
        thread.status = 'reconnecting';
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'reconnecting', error });
      },
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
      onTaskStarted: (taskId, description, skipTranscript, taskType, workflowName, subagentType) => {
        this.threadActivity.set(threadId, description);
        // Background tasks use skipTranscript=true. Track them so we can detect
        // if they're still running when the session ends.
        if (skipTranscript) {
          const active = this.activeBgTasks.get(threadId) ?? new Map<string, { description: string; startedAt: number }>();
          active.set(taskId, { description, startedAt: Date.now() });
          this.activeBgTasks.set(threadId, active);
        }
        this.emit(threadId, { type: 'task_started', taskId, description, skipTranscript, taskType, workflowName, subagentType });
      },
      onTaskUpdated: (taskId, patch) => {
        this.emit(threadId, { type: 'task_updated', taskId, ...patch });
      },
      onTaskProgress: (taskId, description, lastToolName) => {
        const suffix = lastToolName ? ` · ${lastToolName}` : '';
        this.threadActivity.set(threadId, description + suffix);
        this.emit(threadId, { type: 'task_progress', taskId, description, lastToolName });
      },
      onTaskNotification: (taskId, status, summary) => {
        // Task resolved — remove from background tracking set.
        this.activeBgTasks.get(threadId)?.delete(taskId);
        // Also clear from persisted state (handles notifications that arrive
        // on a poll-resume after a previous session missed them).
        this.clearPendingBackgroundTask(threadId, taskId);
        this.emit(threadId, { type: 'task_notification', taskId, status, summary });
      },
      onNotification: (text, priority) => this.emit(threadId, { type: 'notification', text, priority }),
      onApiRetry: (attempt, maxRetries, error) => this.emit(threadId, { type: 'api_retry', attempt, maxRetries, error }),
      onRateLimit: (limitStatus, resetsAt) => this.emit(threadId, { type: 'rate_limit', limitStatus, resetsAt }),
      onModelFallback: (trigger, fromModel, toModel) => this.emit(threadId, { type: 'model_fallback', trigger, fromModel, toModel }),
      onToolProgress: (toolUseId, toolName, elapsedSeconds) => this.emit(threadId, { type: 'tool_progress', toolUseId, toolName, elapsedSeconds }),
      onMemoryRecall: (paths, mode) => this.emit(threadId, { type: 'memory_recall', paths, mode }),
      onCommandsChanged: (commands) => this.emit(threadId, { type: 'commands_changed', commands }),
      onTaskProgressSummary: (taskId, summary) => this.emit(threadId, { type: 'task_progress_summary', taskId, summary }),
      onGitOperation: (summary) => this.emit(threadId, { type: 'git_operation', summary }),
      onToolResult: (toolUseId, status, durationMs) => this.emit(threadId, { type: 'tool_result_status', toolUseId, status, durationMs }),
      onEnterPlanMode: () => this.emit(threadId, { type: 'enter_plan_mode' }),
      onPlanReady: (planText, approve, reject) => {
        // Persist the plan text so the card can be restored after a reload/crash
        // OR after the user switches threads mid-session.
        thread.pendingPlan = planText;
        thread.updatedAt = Date.now();
        this.emit(threadId, { type: 'pending_plan_changed', planText });
        // Wrap callbacks to clear both the persisted plan and the in-memory
        // resolvers when the user acts on the card.
        const wrappedApprove = (editedPlan?: string) => {
          delete thread.pendingPlan;
          thread.updatedAt = Date.now();
          this.pendingPlanResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
          approve(editedPlan);
        };
        const wrappedReject = () => {
          delete thread.pendingPlan;
          thread.updatedAt = Date.now();
          this.pendingPlanResolvers.delete(threadId);
          this.emit(threadId, { type: 'pending_plan_changed', planText: undefined });
          reject();
        };
        // Store resolvers in-memory so restorePendingPlanCard() can re-wire the
        // card after the user switches threads and switches back mid-session.
        this.pendingPlanResolvers.set(threadId, { approve: wrappedApprove, reject: wrappedReject });
        this.emit(threadId, { type: 'plan_ready', planText, approve: wrappedApprove, reject: wrappedReject });
      },
      onCapabilitiesDiscovered: (models, agents) => this.emit(threadId, { type: 'capabilities_discovered', models, agents }),
      onElicitation: (request, signal) =>
        new Promise<import('@anthropic-ai/claude-agent-sdk').ElicitationResult>((resolve) => {
          this.emit(threadId, { type: 'elicitation_request', request, signal, respond: resolve });
        }),
      onFileUserModified: (filePath) => {
        if (!thread.userModifiedFiles) thread.userModifiedFiles = [];
        if (!thread.userModifiedFiles.includes(filePath)) thread.userModifiedFiles.push(filePath);
        this.emit(threadId, { type: 'file_user_modified', filePath });
      },
      onToolResultImages: (images) => {
        const existing = this.pendingToolResultImages.get(threadId) ?? [];
        existing.push(...images);
        this.pendingToolResultImages.set(threadId, existing);
        this.emit(threadId, { type: 'tool_result_images', images });
      },
      onTaskEvent: (event) => {
        this.applyTaskEvent(thread, event);
        this.emit(threadId, { type: 'tasks_updated', tasks: thread.tasks ?? [] });
      },
    };
  }

  /**
   * `ThreadSession._turnInFlight` flips to `false` immediately AFTER
   * onDone/onInterrupted/onError returns (see the `case 'result':` handler
   * in `ThreadSession.pumpMessages()` — the callback fires, THEN
   * `_turnInFlight = false` runs), so emitting `run_state_settled`
   * synchronously from inside those callbacks would race a stale `true`
   * value for `isRunning()`/`turnInFlight`. Deferring to a microtask lets
   * that flip happen first (it runs synchronously, before the pump loop's
   * `for await` can yield control back to the event loop), so listeners
   * re-checking `isRunning()` on this event always see the settled value.
   */
  private emitRunStateSettledWhenIdle(threadId: string): void {
    queueMicrotask(() => {
      debugLog('[ClaudeThreads] run state settled', threadId, 'isRunning:', this.isRunning(threadId));
      this.emit(threadId, { type: 'run_state_settled' });
    });
  }

  /** Merge a task-tracker event from the session into the thread's task list. */
  private applyTaskEvent(thread: Thread, event: TaskTrackerEvent): void {
    if (event.kind === 'replace') {
      thread.tasks = event.tasks.map((t, i) => ({
        id: String(i + 1),
        content: t.content,
        status: t.status,
      }));
    } else if (event.kind === 'create') {
      const tasks = (thread.tasks ??= []);
      const existing = tasks.find(t => t.id === event.id);
      if (existing) existing.content = event.content;
      else tasks.push({ id: event.id, content: event.content, status: 'pending' });
    } else {
      const tasks = (thread.tasks ??= []);
      const existing = tasks.find(t => t.id === event.id);
      if (event.status === 'deleted') {
        if (existing) thread.tasks = tasks.filter(t => t.id !== event.id);
        return;
      }
      const status =
        event.status === 'pending' || event.status === 'in_progress' || event.status === 'completed'
          ? (event.status as TaskItemStatus)
          : undefined;
      if (existing) {
        if (status) existing.status = status;
        if (event.content) existing.content = event.content;
      } else if (event.content) {
        tasks.push({ id: event.id, content: event.content, status: status ?? 'pending' });
      }
    }
    thread.updatedAt = Date.now();
  }

  /** Build the sessionOptions object from plugin settings (and thread-level overrides). */
  private buildSessionOptions(thread: Thread): ThreadSessionOptions['sessionOptions'] {
    const s = this.settings;
    const opts: {
      thinking?: Options['thinking'];
      effort?: Options['effort'];
      agentProgressSummaries?: boolean;
      betas?: SdkBeta[];
      persistSession?: boolean;
      plugins?: import('@anthropic-ai/claude-agent-sdk').SdkPluginConfig[];
      agents?: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>;
    } = {};

    // Thinking mode
    if (s.thinkingMode && s.thinkingMode !== 'disabled') {
      if (s.thinkingMode === 'adaptive') {
        opts.thinking = { type: 'adaptive' };
      } else {
        opts.thinking = { type: 'enabled', budgetTokens: s.thinkingBudgetTokens ?? 8000 };
      }
    }

    // Effort level
    if (s.effort && s.effort !== 'default') {
      opts.effort = s.effort as Options['effort'];
    }

    // Agent progress summaries
    opts.agentProgressSummaries = s.agentProgressSummaries ?? true;

    // 1M context beta
    if (s.enable1MContext) {
      opts.betas = ['context-1m-2025-08-07'];
    }

    // Ephemeral session (thread-level flag)
    if (thread.ephemeral) {
      opts.persistSession = false;
    }

    // GitHub skill source plugins — enumerate each skill subdir and pass as individual
    // local plugins. --plugin-dir / plugins:{type:'local'} requires the path to be an
    // individual skill directory (containing SKILL.md), not the repo root.
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path');
      const plugins: import('@anthropic-ai/claude-agent-sdk').SdkPluginConfig[] = [];
      for (const src of (s.skillSources ?? [])) {
        if (src.type !== 'github' || !src.clonePath) continue;
        // Resolve skills dir: read plugin.json if present, else fall back to <clone>/skills
        let skillsDir = path.join(src.clonePath, 'skills');
        try {
          const manifestPath = path.join(src.clonePath, '.claude-plugin', 'plugin.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
          if (typeof manifest.skills === 'string') {
            skillsDir = path.join(src.clonePath, manifest.skills);
          }
        } catch { /* no manifest or bad JSON — use default */ }

        try {
          const entries = fs.readdirSync(skillsDir);
          for (const entry of entries) {
            const entryPath = path.join(skillsDir, entry);
            try {
              if (!fs.statSync(entryPath).isDirectory()) continue;
              if (!fs.existsSync(path.join(entryPath, 'SKILL.md'))) continue;
              plugins.push({ type: 'local', path: entryPath });
            } catch { continue; }
          }
        } catch { /* skills dir missing or unreadable */ }
      }

      // Bundled thread-orchestrator skill — ships inside the plugin's own dist/
      // (copied there by esbuild.config.mjs from resources/skills/), so it is
      // discoverable in every session with nothing manually copied into
      // ~/.claude/skills/. Registered unconditionally (not gated by any
      // setting) alongside the GitHub-sourced skill plugins above.
      if (this.pluginResourceDir) {
        const bundledSkillPath = path.join(this.pluginResourceDir, 'resources', 'skills', 'thread-orchestrator');
        try {
          if (fs.existsSync(path.join(bundledSkillPath, 'SKILL.md'))) {
            plugins.push({ type: 'local', path: bundledSkillPath });
          }
        } catch { /* bundled skill missing — plugin dist may be stale, skip silently */ }
      }

      if (plugins.length > 0) opts.plugins = plugins;
    }

    // GitHub agent definitions — read agent .md files listed in plugin.json and
    // pass them via options.agents so Claude Code can spawn them as subagents.
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path');
      const agents: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition> = {};
      for (const src of (s.skillSources ?? [])) {
        if (src.type !== 'github' || !src.clonePath) continue;
        try {
          const manifestPath = path.join(src.clonePath, '.claude-plugin', 'plugin.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
          const agentPaths = Array.isArray(manifest.agents) ? manifest.agents as string[] : [];
          for (const relPath of agentPaths) {
            try {
              const absPath = path.join(src.clonePath, relPath);
              const content = fs.readFileSync(absPath, 'utf-8');
              const parsed = parseAgentMarkdown(content);
              if (parsed.name && parsed.description && parsed.prompt) {
                agents[parsed.name] = { description: parsed.description, prompt: parsed.prompt };
              }
            } catch { continue; }
          }
        } catch { /* no manifest or no agents list */ }
      }
      if (Object.keys(agents).length > 0) opts.agents = agents;
    }

    return opts;
  }

  /**
   * Returns a context usage snapshot for the active session on the given thread.
   * Returns null when no session is running or the SDK call fails.
   */
  async getContextUsage(threadId: string): Promise<import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse | null> {
    const session = this.sessions.get(threadId);
    if (!session) return null;
    return session.getContextUsage();
  }

  async interrupt(threadId: string): Promise<void> {
    // ADR-0002 §2: a single ThreadSession per thread — no more lingering-
    // session fallback needed, since the same session that's mid-turn is
    // the same session that would otherwise have "lingered."
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

  /**
   * Notify listeners that a thread's pending ScheduleWakeup set changed
   * (registered, fired, or cancelled). The wake-up timers themselves live in
   * the plugin (alongside the background-task poll timers), so this is a thin
   * pass-through that lets the dashboard and chat view re-read wake-up state.
   */
  notifyWakeupChanged(threadId: string): void {
    this.emit(threadId, { type: 'wakeup_changed' });
  }

  /** Notify listeners that a thread's orchestrator tracking notes changed. */
  notifyManagerNotesChanged(threadId: string): void {
    this.emit(threadId, { type: 'manager_notes_changed' });
  }

  /** Notify listeners that a thread's proposed reply was set or cleared. */
  notifyProposedReplyChanged(threadId: string): void {
    this.emit(threadId, { type: 'proposed_reply_changed' });
  }

  private emit(threadId: string, event: ThreadEvent): void {
    for (const listener of this.listeners) {
      listener(threadId, event);
    }
  }

  /**
   * Gracefully shuts down all live sessions by sending an interrupt signal
   * to each one, waiting briefly for in-flight turns to settle, then closing
   * every `ThreadSession` (idle or not) and clearing the map.
   *
   * ADR-0002 §4: under the long-lived-session model, a `sessions` entry no
   * longer self-removes when a turn finishes (unlike the old per-turn
   * `ClaudeSession`, whose `onDone`/`onInterrupted` deleted it) — the
   * `ThreadSession` stays warm, idle, for the thread's whole lifetime. So
   * "poll until the map drains" no longer signals anything: an idle session
   * would sit in the map forever and the old poll loop would spin until
   * `timeoutMs` on every shutdown. Instead, poll only until no session has a
   * turn in flight (or the deadline passes), then force `close()` on
   * everything unconditionally — a graceful shutdown always tears every
   * subprocess down; `timedOut` just reports whether interrupted turns had
   * time to settle cleanly first. This also means "how many active threads
   * exist" (not "how many have a turn in flight right now") sets the real
   * blast radius on an ungraceful reload — see ADR-0002 §4's note to
   * re-verify this budget once real concurrency is observed.
   *
   * @param timeoutMs  Maximum milliseconds to wait for in-flight turns to
   *                   settle before force-closing. Defaults to 10 000 (10s).
   */
  async gracefulShutdown(timeoutMs = 10_000): Promise<{ timedOut: boolean }> {
    if (this.sessions.size === 0) return { timedOut: false };

    const busyIds = [...this.sessions.entries()].filter(([, s]) => s.turnInFlight).map(([id]) => id);

    // Fire interrupt signals in parallel — errors are non-fatal.
    // We deliberately do NOT await these: interrupt() may not resolve until the
    // session's internal turn completes, which could take longer than our timeout.
    for (const id of busyIds) {
      this.interrupt(id).catch(() => {});
    }

    // Poll until every session has settled (no turn in flight) or we hit the deadline.
    const deadline = Date.now() + timeoutMs;
    const anyBusy = () => [...this.sessions.values()].some((s) => s.turnInFlight);
    while (anyBusy() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }

    const timedOut = anyBusy();

    // Force-close every session regardless of whether it settled in time —
    // idle sessions never would have drained from the map on their own.
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    return { timedOut };
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
    '- EnterWorktree / ExitWorktree are automatically routed to the plugin\'s MCP versions (enter_worktree / exit_worktree), which read the effective cwd set by set_working_directory.',
    '- ScheduleWakeup injects the given prompt as a new message into this thread after the delay.',
    '- obsidian_list_commands returns all registered Obsidian commands (id + name); pass a query to filter. Call this before obsidian_execute_command to look up the correct command ID.',
    '- obsidian_execute_command triggers any Obsidian command by ID — useful for vault-bridge sync, git push, toggling editor modes, etc.',
    '- obsidian_open_url opens a URL directly in the Obsidian Web Viewer panel (reuses an existing tab by default). Use this to open local dev servers, HTML files, or any web page without the user having to type the URL.',
  );

  return lines.join('\n');
}


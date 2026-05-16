import { ClaudeSession } from './ClaudeSession';
import type { Thread, ChatMessage, PluginSettings, ToolCallRecord, AskQuestion, ImageAttachment, Project } from './types';
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
  | { type: 'queued'; text: string }
  | { type: 'dequeued'; text: string }
  | { type: 'status'; status: 'compacting' | 'requesting' | null }
  | { type: 'compact'; message: ChatMessage }
  | { type: 'task_started'; taskId: string; description: string; skipTranscript: boolean }
  | { type: 'task_progress'; taskId: string; description: string; lastToolName?: string }
  | { type: 'task_notification'; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string }
  | { type: 'notification'; text: string; priority: 'low' | 'medium' | 'high' | 'immediate' }
  | { type: 'api_retry'; attempt: number; maxRetries: number; error: string }
  | { type: 'rate_limit'; limitStatus: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number }
  | { type: 'interrupted' }
  | { type: 'thread_deleted' }
  | { type: 'thread_created' }
  | { type: 'permission_request'; toolName: string; detail: string }
  | { type: 'permission_resolved' }
  | { type: 'active_thread_changed' };

export class ThreadManager {
  private threads: Map<string, Thread> = new Map();
  private projects: Map<string, Project> = new Map();
  private sessions: Map<string, ClaudeSession> = new Map();
  private queuedMessages: Map<string, string[]> = new Map();
  private threadActivity: Map<string, string> = new Map();
  private pendingPermissions: Map<string, { toolName: string; detail: string }> = new Map();
  private permissionResolvers: Map<string, (allow: boolean) => void> = new Map();
  private listeners: Set<ThreadStateListener> = new Set();
  private settings: PluginSettings;
  mcpServers: Record<string, McpServerConfig> | undefined = undefined;
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
    }
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

  getQueuedMessage(id: string): string | undefined {
    const queue = this.queuedMessages.get(id);
    return queue && queue.length > 0 ? queue[0] : undefined;
  }

  getQueuedCount(id: string): number {
    return this.queuedMessages.get(id)?.length ?? 0;
  }

  getThreadActivity(id: string): string | undefined {
    return this.threadActivity.get(id);
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
      queue.push(userText);
      this.queuedMessages.set(threadId, queue);
      this.emit(threadId, { type: 'queued', text: userText });
      return;
    }

    thread.lastError = undefined;
    this.threadActivity.delete(threadId);

    const keywordModel = this.resolveModel(userText);
    const model = keywordModel ?? thread.model;
    const promptText = keywordModel ? this.stripKeyword(userText) : userText;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
      timestamp: Date.now(),
    };
    thread.messages.push(userMsg);
    thread.updatedAt = Date.now();

    const session = new ClaudeSession(this.settings.claudeBinaryPath);
    this.sessions.set(threadId, session);
    this.emit(threadId, { type: 'streaming_start' });

    if (model) {
      this.emit(threadId, { type: 'escalated', model });
    }

    let streamingContent = '';
    const pendingToolCalls: ToolCallRecord[] = [];
    let completedSuccessfully = false;

    const additionalDirs = [...new Set([this.vaultRoot, thread.cwd].filter(Boolean))];
    const project = thread.projectId ? this.getProject(thread.projectId) : undefined;
    const appendSystemPrompt = project?.description?.trim() || undefined;

    await session.run(
      promptText,
      thread.sessionId,
      thread.cwd,
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
          this.emit(threadId, { type: 'message', message: assistantMsg });
        },
        onDone: (sessionId, cost) => {
          thread.sessionId = sessionId;
          thread.updatedAt = Date.now();
          const lastMsg = thread.messages[thread.messages.length - 1];
          if (lastMsg?.role === 'assistant' && cost > 0) {
            lastMsg.cost = cost;
          }
          this.sessions.delete(threadId);
          this.threadActivity.delete(threadId);
          completedSuccessfully = true;
          this.emit(threadId, { type: 'done' });
        },
        onInterrupted: (_sessionId) => {
          // Roll back the orphaned user message — it was never processed by Claude Code
          const lastMsg = thread.messages[thread.messages.length - 1];
          if (lastMsg && lastMsg.id === userMsg.id) {
            thread.messages.pop();
          }
          thread.updatedAt = Date.now();
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
          this.emit(threadId, { type: 'task_started', taskId, description, skipTranscript });
        },
        onTaskProgress: (taskId, description, lastToolName) => {
          const suffix = lastToolName ? ` · ${lastToolName}` : '';
          this.threadActivity.set(threadId, description + suffix);
          this.emit(threadId, { type: 'task_progress', taskId, description, lastToolName });
        },
        onTaskNotification: (taskId, status, summary) => this.emit(threadId, { type: 'task_notification', taskId, status, summary }),
        onNotification: (text, priority) => this.emit(threadId, { type: 'notification', text, priority }),
        onApiRetry: (attempt, maxRetries, error) => this.emit(threadId, { type: 'api_retry', attempt, maxRetries, error }),
        onRateLimit: (limitStatus, resetsAt) => this.emit(threadId, { type: 'rate_limit', limitStatus, resetsAt }),
      },
      additionalDirs,
      model,
      images,
      appendSystemPrompt,
      this.mcpServers,
    );

    if (completedSuccessfully) {
      const queue = this.queuedMessages.get(threadId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.queuedMessages.delete(threadId);
        this.emit(threadId, { type: 'dequeued', text: next });
        await this.sendMessage(threadId, next);
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


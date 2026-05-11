import { ClaudeSession } from './ClaudeSession';
import type { Thread, ChatMessage, PluginSettings, ToolCallRecord, AskQuestion, ImageAttachment } from './types';

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
  | { type: 'task_started'; taskId: string; description: string; skipTranscript: boolean }
  | { type: 'task_progress'; taskId: string; description: string; lastToolName?: string }
  | { type: 'task_notification'; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string }
  | { type: 'notification'; text: string; priority: 'low' | 'medium' | 'high' | 'immediate' }
  | { type: 'api_retry'; attempt: number; maxRetries: number; error: string }
  | { type: 'rate_limit'; limitStatus: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number };

export class ThreadManager {
  private threads: Map<string, Thread> = new Map();
  private sessions: Map<string, ClaudeSession> = new Map();
  private queuedMessages: Map<string, string> = new Map();
  private listeners: Set<ThreadStateListener> = new Set();
  private settings: PluginSettings;
  permissionHandler: (toolName: string, detail: string) => Promise<boolean> = async () => false;
  questionHandler: (questions: AskQuestion[]) => Promise<Record<string, string>> = async () => ({});
  openNewTabHandler: (title?: string, initialPrompt?: string) => Promise<{ threadId: string; title: string }> = async (title) => ({ threadId: '', title: title ?? 'New Thread' });
  vaultRoot = '';

  constructor(settings: PluginSettings) {
    this.settings = settings;
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  loadThreads(threads: Thread[]): void {
    for (const t of threads) {
      this.threads.set(t.id, t);
    }
  }

  getThreads(): Thread[] {
    return Array.from(this.threads.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getThread(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  createThread(title: string, cwd?: string): Thread {
    const thread: Thread = {
      id: crypto.randomUUID(),
      title: title || `Thread ${this.threads.size + 1}`,
      cwd: cwd ?? this.settings.defaultCwd,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  deleteThread(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.close();
      this.sessions.delete(id);
    }
    this.queuedMessages.delete(id);
    this.threads.delete(id);
  }

  renameThread(id: string, title: string): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.title = title;
      thread.updatedAt = Date.now();
    }
  }

  isRunning(id: string): boolean {
    return this.sessions.has(id);
  }

  getQueuedMessage(id: string): string | undefined {
    return this.queuedMessages.get(id);
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
      this.queuedMessages.set(threadId, userText);
      this.emit(threadId, { type: 'queued', text: userText });
      return;
    }

    const model = this.resolveModel(userText);
    const promptText = model ? this.stripKeyword(userText) : userText;

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
          completedSuccessfully = true;
          this.emit(threadId, { type: 'done' });
        },
        onError: (err) => {
          this.sessions.delete(threadId);
          this.queuedMessages.delete(threadId);
          this.emit(threadId, { type: 'error', error: err });
        },
        onPermissionRequest: (toolName, detail) => this.permissionHandler(toolName, detail),
        onAskUserQuestion: (questions) => this.questionHandler(questions),
        onOpenNewTab: (title, initialPrompt) => this.openNewTabHandler(title, initialPrompt),
        onStatus: (status) => this.emit(threadId, { type: 'status', status }),
        onTaskStarted: (taskId, description, skipTranscript) => this.emit(threadId, { type: 'task_started', taskId, description, skipTranscript }),
        onTaskProgress: (taskId, description, lastToolName) => this.emit(threadId, { type: 'task_progress', taskId, description, lastToolName }),
        onTaskNotification: (taskId, status, summary) => this.emit(threadId, { type: 'task_notification', taskId, status, summary }),
        onNotification: (text, priority) => this.emit(threadId, { type: 'notification', text, priority }),
        onApiRetry: (attempt, maxRetries, error) => this.emit(threadId, { type: 'api_retry', attempt, maxRetries, error }),
        onRateLimit: (limitStatus, resetsAt) => this.emit(threadId, { type: 'rate_limit', limitStatus, resetsAt }),
      },
      additionalDirs,
      model,
      images,
    );

    if (completedSuccessfully) {
      const queued = this.queuedMessages.get(threadId);
      if (queued) {
        this.queuedMessages.delete(threadId);
        this.emit(threadId, { type: 'dequeued', text: queued });
        await this.sendMessage(threadId, queued);
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

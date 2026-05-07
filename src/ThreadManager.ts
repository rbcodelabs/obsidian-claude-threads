import { ClaudeSession } from './ClaudeSession';
import type { Thread, ChatMessage, PluginSettings, ToolCallRecord } from './types';

type ThreadStateListener = (threadId: string, event: ThreadEvent) => void;

export type ThreadEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_use'; record: ToolCallRecord }
  | { type: 'message'; message: ChatMessage }
  | { type: 'done' }
  | { type: 'error'; error: Error }
  | { type: 'streaming_start' };

export class ThreadManager {
  private threads: Map<string, Thread> = new Map();
  private sessions: Map<string, ClaudeSession> = new Map();
  private listeners: Set<ThreadStateListener> = new Set();
  private settings: PluginSettings;

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
    return Array.from(this.threads.values()).sort((a, b) => b.updatedAt - a.updatedAt);
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

  async sendMessage(threadId: string, userText: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    if (this.sessions.has(threadId)) return;

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

    let streamingContent = '';
    const pendingToolCalls: ToolCallRecord[] = [];

    await session.run(
      userText,
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
          this.emit(threadId, { type: 'done' });
        },
        onError: (err) => {
          this.sessions.delete(threadId);
          this.emit(threadId, { type: 'error', error: err });
        },
      },
    );
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

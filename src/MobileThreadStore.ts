/**
 * MobileThreadStore.ts
 *
 * In-memory store for the mobile client. Hydrated from the desktop's snapshot
 * frame and kept up-to-date by incremental RelayFrames.
 *
 * No VaultPersistence calls — mobile has no local Claude sessions.
 */

import type { RelayFrame, SerializedThread, SerializedMessage, PendingPermission } from './relay-protocol';
import type { ToolCallRecord } from './types';

type StoreListener = () => void;

export class MobileThreadStore {
  private threads: Map<string, SerializedThread> = new Map();
  private activeThreadId: string | null = null;
  private listeners: Set<StoreListener> = new Set();
  /** Pending permissions keyed by requestId. */
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  /** Partially accumulated streaming token for the active streaming message. */
  private streamingContent: Map<string, string> = new Map();
  /** Tool calls fired during the current streaming turn, keyed by threadId. */
  private streamingTools: Map<string, ToolCallRecord[]> = new Map();

  // ── Public accessors ──────────────────────────────────────────────────

  getThreads(): SerializedThread[] {
    return Array.from(this.threads.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getThread(id: string): SerializedThread | undefined {
    return this.threads.get(id);
  }

  getActiveThreadId(): string | null {
    return this.activeThreadId;
  }

  getActiveThread(): SerializedThread | undefined {
    return this.activeThreadId ? this.threads.get(this.activeThreadId) : undefined;
  }

  getPendingPermissions(): PendingPermission[] {
    return Array.from(this.pendingPermissions.values());
  }

  getPendingPermissionsForThread(threadId: string): PendingPermission[] {
    return Array.from(this.pendingPermissions.values()).filter(p => p.threadId === threadId);
  }

  getStreamingContent(threadId: string): string {
    return this.streamingContent.get(threadId) ?? '';
  }

  getStreamingTools(threadId: string): ToolCallRecord[] {
    return this.streamingTools.get(threadId) ?? [];
  }

  isStreaming(threadId: string): boolean {
    return this.streamingContent.has(threadId);
  }

  /** Subscribe to any store change. Returns an unsubscribe function. */
  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Frame handling ────────────────────────────────────────────────────

  applyFrame(frame: RelayFrame): void {
    switch (frame.type) {
      case 'snapshot':
        this.applySnapshot(frame.threads, frame.activeThreadId);
        break;

      case 'thread_created':
        this.threads.set(frame.thread.id, frame.thread);
        this.activeThreadId = frame.thread.id;
        this.notify();
        break;

      case 'thread_deleted':
        this.threads.delete(frame.threadId);
        this.streamingContent.delete(frame.threadId);
        // Clear permissions for this thread
        for (const [id, p] of this.pendingPermissions) {
          if (p.threadId === frame.threadId) this.pendingPermissions.delete(id);
        }
        if (this.activeThreadId === frame.threadId) {
          const remaining = this.getThreads();
          this.activeThreadId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        }
        this.notify();
        break;

      case 'thread_renamed': {
        const t = this.threads.get(frame.threadId);
        if (t) {
          this.threads.set(frame.threadId, { ...t, title: frame.title });
        }
        this.notify();
        break;
      }

      case 'streaming_start':
        this.streamingContent.set(frame.threadId, '');
        this.streamingTools.set(frame.threadId, []);
        this.notify();
        break;

      case 'token': {
        const prev = this.streamingContent.get(frame.threadId) ?? '';
        this.streamingContent.set(frame.threadId, prev + frame.text);
        this.notify();
        break;
      }

      case 'tool_use': {
        const tools = this.streamingTools.get(frame.threadId) ?? [];
        this.streamingTools.set(frame.threadId, [...tools, { name: frame.name, summary: frame.summary }]);
        this.notify();
        break;
      }

      case 'message': {
        const thread = this.threads.get(frame.threadId);
        if (thread) {
          this.threads.set(frame.threadId, {
            ...thread,
            messages: [...thread.messages, frame.message],
            updatedAt: Date.now(),
          });
        }
        // Clear streaming state for this thread — the final message has arrived
        this.streamingContent.delete(frame.threadId);
        this.streamingTools.delete(frame.threadId);
        this.notify();
        break;
      }

      case 'done':
        this.streamingContent.delete(frame.threadId);
        this.streamingTools.delete(frame.threadId);
        this.notify();
        break;

      case 'error': {
        const errThread = this.threads.get(frame.threadId);
        if (errThread) {
          this.threads.set(frame.threadId, { ...errThread, lastError: frame.error });
        }
        this.streamingContent.delete(frame.threadId);
        this.streamingTools.delete(frame.threadId);
        this.notify();
        break;
      }

      case 'status': {
        // Status changes don't mutate thread data; view reads streaming state separately
        // Notify so the view can update status indicators
        this.notify();
        break;
      }

      case 'permission_request':
        this.pendingPermissions.set(frame.requestId, {
          threadId: frame.threadId,
          toolName: frame.toolName,
          detail: frame.detail,
          requestId: frame.requestId,
        });
        this.notify();
        break;

      case 'permission_resolved':
        // Remove the permission for the thread (requestId may be empty for legacy path)
        if (frame.requestId) {
          this.pendingPermissions.delete(frame.requestId);
        } else {
          // Fallback: remove the first pending permission for the thread
          for (const [id, p] of this.pendingPermissions) {
            if (p.threadId === frame.threadId) {
              this.pendingPermissions.delete(id);
              break;
            }
          }
        }
        this.notify();
        break;

      case 'desktop_reconnected':
        // Desktop reconnected — clear all state; snapshot is coming
        this.clear();
        this.notify();
        break;

      case 'pong':
        // Handled by RelayClient; should not reach here
        break;

      default:
        console.warn('[MobileThreadStore] Unknown frame type:', (frame as { type: string }).type);
    }
  }

  // ── Private ───────────────────────────────────────────────────────────

  private applySnapshot(threads: SerializedThread[], activeThreadId: string | null): void {
    this.threads.clear();
    this.streamingContent.clear();
    this.pendingPermissions.clear();

    for (const thread of threads) {
      this.threads.set(thread.id, thread);
    }

    this.activeThreadId = activeThreadId;
    if (this.activeThreadId && !this.threads.has(this.activeThreadId)) {
      const all = this.getThreads();
      this.activeThreadId = all.length > 0 ? all[all.length - 1].id : null;
    }

    this.notify();
  }

  private clear(): void {
    this.threads.clear();
    this.streamingContent.clear();
    this.streamingTools.clear();
    this.pendingPermissions.clear();
    this.activeThreadId = null;
  }

  /** Select a different thread (called from MobileView when user taps a thread). */
  setActiveThreadId(id: string): void {
    if (this.threads.has(id)) {
      this.activeThreadId = id;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[MobileThreadStore] Listener error:', err);
      }
    }
  }
}

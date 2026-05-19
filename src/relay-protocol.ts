/**
 * relay-protocol.ts
 *
 * All TypeScript types for the Claude Threads remote-access wire protocol.
 * Both RelayClient and MobileThreadStore import from here. Never duplicate
 * these types elsewhere.
 */

import type { MessageRole, ToolCallRecord } from './types';

// ── Serialized domain objects ──────────────────────────────────────────────

/** JSON-safe version of ChatMessage (no class instances, no functions). */
export interface SerializedMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCallRecord[];
  cost?: number;
  compactTrigger?: 'auto' | 'manual';
  preTokens?: number;
  /** Images attached to this user message, base64-encoded for display in mobile history. */
  images?: Array<{ base64: string; mediaType: string; name: string }>;
}

/** JSON-safe version of Thread (no class instances, no functions). */
export interface SerializedThread {
  id: string;
  title: string;
  cwd: string;
  messages: SerializedMessage[];
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  recap?: string;
  summary?: string;
  lastError?: string;
  model?: string;
  projectId?: string;
}

// ── Desktop → Mobile frames ────────────────────────────────────────────────

/**
 * Frames sent from desktop to mobile over the relay.
 * The relay forwards them verbatim.
 */
export type RelayFrame =
  | { type: 'snapshot'; threads: SerializedThread[]; activeThreadId: string | null }
  | { type: 'token'; threadId: string; text: string }
  | { type: 'tool_use'; threadId: string; name: string; summary: string }
  | { type: 'message'; threadId: string; message: SerializedMessage }
  | { type: 'done'; threadId: string }
  | { type: 'error'; threadId: string; error: string }
  | { type: 'streaming_start'; threadId: string }
  | { type: 'thread_created'; thread: SerializedThread }
  | { type: 'thread_deleted'; threadId: string }
  | { type: 'thread_renamed'; threadId: string; title: string }
  | { type: 'permission_request'; threadId: string; toolName: string; detail: string; requestId: string }
  | { type: 'permission_resolved'; threadId: string; requestId: string }
  | { type: 'status'; threadId: string; status: 'compacting' | 'requesting' | null }
  | { type: 'queued'; threadId: string; text: string; count: number }
  | { type: 'dequeued'; threadId: string }
  | { type: 'desktop_reconnected' }
  | { type: 'pong' };

// ── Mobile → Desktop commands ──────────────────────────────────────────────

/**
 * Commands sent from mobile to desktop over the relay.
 * The relay forwards them verbatim; the desktop RelayClient dispatches them.
 */
export type RemoteCommand =
  | { type: 'send_message'; threadId: string; text: string; images?: Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; name: string }> }
  | { type: 'stop_session'; threadId: string }
  | { type: 'resolve_permission'; threadId: string; requestId: string; allow: boolean }
  | { type: 'create_thread'; title: string; cwd?: string }
  | { type: 'set_active_thread'; threadId: string }
  | { type: 'ping' };

// ── Connection state ───────────────────────────────────────────────────────

export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

// ── Pending permission ─────────────────────────────────────────────────────

export interface PendingPermission {
  threadId: string;
  toolName: string;
  detail: string;
  requestId: string;
}

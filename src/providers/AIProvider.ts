/**
 * AIProvider — the shared interface that every AI backend adapter must satisfy.
 *
 * Both AnthropicProvider (Claude Agent SDK / subprocess) and OpenAIProvider
 * (OpenAI Responses API / Chat Completions) implement this contract so that
 * ThreadManager never needs to know which SDK is active.
 *
 * All adapters fire the same SessionCallbacks events; providers that lack a
 * capability (e.g. OpenAI has no session resumption) degrade silently — they
 * reconstruct context from conversationHistory instead of a sessionId, and they
 * omit callbacks they cannot drive (onCompact, onTaskStarted, etc.).
 *
 * NOTE: SessionCallbacks is defined here (not in ClaudeSession) so this file
 * has no circular dependency. ClaudeSession re-exports it for backward compat.
 */

import type { ToolCallRecord, AskQuestion, ImageAttachment, ChatMessage } from '../types';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// ── SessionCallbacks ──────────────────────────────────────────────────────────

/**
 * Event callbacks fired by any AIProvider during a session turn.
 * ThreadManager wires these to its internal state machine.
 */
export interface SessionCallbacks {
  onToken: (text: string) => void;
  onToolUse: (record: ToolCallRecord) => void;
  onMessage: (content: string, toolCalls: ToolCallRecord[]) => void;
  onRecap: (summary: string) => void;
  onDone: (sessionId: string, cost: number, numTurns: number) => void;
  onInterrupted: (sessionId: string) => void;
  onError: (err: Error) => void;
  onPermissionRequest: (toolName: string, detail: string) => Promise<boolean>;
  onAskUserQuestion: (questions: AskQuestion[]) => Promise<Record<string, string>>;
  onOpenNewTab: (title?: string, initialPrompt?: string) => Promise<{ threadId: string; title: string }>;
  onStatus?: (status: 'compacting' | 'requesting' | null) => void;
  onCompact?: (trigger: 'auto' | 'manual', preTokens: number) => void;
  onTaskStarted?: (taskId: string, description: string, skipTranscript: boolean) => void;
  onTaskProgress?: (taskId: string, description: string, lastToolName?: string) => void;
  onTaskNotification?: (taskId: string, status: 'completed' | 'failed' | 'stopped', summary: string) => void;
  onNotification?: (text: string, priority: 'low' | 'medium' | 'high' | 'immediate') => void;
  onApiRetry?: (attempt: number, maxRetries: number, error: string) => void;
  onRateLimit?: (status: 'allowed' | 'allowed_warning' | 'rejected', resetsAt?: number) => void;
  /** Fired when a tool result contains inline images (e.g. the Read tool reading a PNG). */
  onToolResultImages?: (images: Array<{ mediaType: string; data: string }>) => void;
}

// ── Capability flags ──────────────────────────────────────────────────────────

export interface ProviderCapabilities {
  /** Provider emits tokens progressively as they are generated. */
  streaming: boolean;
  /**
   * Provider can resume a prior session by opaque ID so the full conversation
   * history need not be re-sent on each turn.
   */
  sessionResumption: boolean;
  /**
   * Provider supports `canUseTool` / permissionMode gating — i.e. the user can
   * approve or deny individual tool calls before they execute.
   */
  toolPermissionGating: boolean;
  /** Provider can attach MCP server configs for Obsidian tool access. */
  mcpServers: boolean;
  /** Provider accepts image / screenshot inputs. */
  visionInput: boolean;
  /**
   * Provider supports sandboxed code execution (Codex container tool or
   * equivalent). When true, codeExecution may be enabled in settings.
   */
  codeExecution: boolean;
  /**
   * Provider supports keyword-triggered model escalation (e.g. /opus switches
   * to a more capable model mid-conversation).
   */
  opusEscalation: boolean;
}

// ── Run options ───────────────────────────────────────────────────────────────

export interface RunOptions {
  /** The new user message to send. */
  prompt: string;
  /**
   * Opaque session identifier returned by the previous turn's onDone callback.
   * Providers that support sessionResumption use this to avoid re-sending
   * history. Providers without sessionResumption ignore it and rely on
   * conversationHistory instead.
   */
  resumeSessionId: string | undefined;
  /** Filesystem working directory for the session. */
  cwd: string;
  /** Permission mode string forwarded to the Claude Agent SDK. */
  permissionMode: string;
  /** Raw KEY=VALUE lines merged into the session environment. */
  extraEnvRaw: string;
  /** Event callbacks that ThreadManager wires to its state machine. */
  callbacks: SessionCallbacks;
  /** Additional directories the agent may read / write. */
  additionalDirectories?: string[];
  /**
   * Explicit model name override (e.g. 'opus', 'codex-mini-latest').
   * Falls back to provider default when absent.
   */
  model?: string;
  /** Images to attach to this turn (user message). */
  images?: ImageAttachment[];
  /** Extra text appended to the system prompt. */
  appendSystemPrompt?: string;
  /** MCP server configs. Ignored by providers without mcpServers capability. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Secret environment variables resolved from the OS keychain at session start. */
  secretEnv?: Record<string, string>;
  /**
   * Structured prior conversation for providers that cannot resume by sessionId.
   * OpenAIProvider uses this to reconstruct multi-turn context on every call.
   * AnthropicProvider ignores it when a valid resumeSessionId is present.
   */
  conversationHistory?: ChatMessage[];
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface AIProvider {
  /** Static description of what this provider supports. Read before calling run(). */
  readonly capabilities: ProviderCapabilities;

  /**
   * Execute one user turn. Fires callbacks as events arrive and resolves when
   * the turn is complete (or the provider has signalled an error/interruption).
   */
  run(opts: RunOptions): Promise<void>;

  /**
   * Signal the active run() call to stop. Safe to call when idle.
   */
  interrupt(): Promise<void>;

  /**
   * Release any long-lived resources. Called when a thread is deleted or the
   * plugin unloads.
   */
  close(): void;
}

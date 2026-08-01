import {
  query,
  type Options,
  type Query,
  type CanUseTool,
  type SDKUserMessage,
  type McpServerConfig,
  type PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import type { ToolCallRecord, ImageAttachment } from './types';
import { parseExtraEnv } from './types';
import { debugLog } from './logger';
import { formatToolName, getToolIcon } from './toolNameUtils';
// SessionCallbacks/TaskTrackerEvent are ClaudeSession.ts's contract, kept as the
// single canonical definition while the two classes coexist during the Stage 2
// migration (see ADR-0002 §2: "the callback contract ... preserved verbatim").
// Re-exported here so ThreadManager (and, later, its tests) can import either
// from ClaudeSession or ThreadSession without caring which module "owns" it.
import { type SessionCallbacks, type TaskTrackerEvent } from './ClaudeSession';
export { formatToolName, getToolIcon };
export type { SessionCallbacks, TaskTrackerEvent };
import {
  isTransportClosedError,
  shouldAutoRetryTransportError,
  TRANSPORT_ERROR_CONTINUATION_PROMPT,
} from './transportErrorRecovery';

/**
 * Everything needed to open a thread's long-lived `Query`, once, for the
 * thread's full lifetime. Per-turn content (text/images) does NOT belong
 * here — it goes through `send()` instead, which pushes onto the already-open
 * generator (see ADR-0002 §2's live-CLI probe: pushing onto the held-open
 * generator is safe unconditionally, mid-turn or not, so there is no
 * per-turn "build a new prompt" step the way `ClaudeSession.run()` had one).
 */
export interface ThreadSessionOptions {
  claudePath: string;
  cwd: string;
  permissionMode: Options['permissionMode'];
  extraEnvRaw: string;
  /** SDK session id to resume, if any (e.g. a previously-persisted `thread.sessionId`). */
  resume?: string;
  callbacks: SessionCallbacks;
  additionalDirectories?: string[];
  model?: string;
  appendSystemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
  secretEnv?: Record<string, string>;
  disallowedTools?: string[];
  sessionOptions?: {
    thinking?: Options['thinking'];
    effort?: Options['effort'];
    agentProgressSummaries?: boolean;
    betas?: import('@anthropic-ai/claude-agent-sdk').SdkBeta[];
    persistSession?: boolean;
    plugins?: import('@anthropic-ai/claude-agent-sdk').SdkPluginConfig[];
    agents?: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>;
  };
}

export type RestartReason = 'cwd-change' | 'transport-error' | 'init-options-change';

/**
 * One `ThreadSession` per thread, not per turn — owns a single SDK `Query`
 * for as long as the thread stays warm. Replaces the per-turn `ClaudeSession`
 * model (see ADR-0002): there is only ever one `Query` per thread, so there
 * is nothing for a second session to race for that `Query`'s stdin.
 *
 * `send()` pushes directly onto the held-open input generator, unconditionally,
 * whether or not a turn is currently in flight — confirmed safe against the
 * live CLI (ADR-0002 §2). There is deliberately no queue-and-wait layer here:
 * the CLI itself coalesces concurrent pushes into the current generation.
 */
export class ThreadSession {
  private query: Query | null = null;

  // --- push-channel state (the held-open async generator handed to query()) ---
  private pushQueue: SDKUserMessage[] = [];
  private pushWaiters: Array<(result: IteratorResult<SDKUserMessage, undefined>) => void> = [];
  private channelEnded = true; // true until start() opens a fresh channel

  private interrupted = false;
  private currentOptions: ThreadSessionOptions | null = null;
  /** Latest SDK session id seen on a successful `result`, used to resume across restart(). */
  private lastKnownSessionId: string | undefined;
  /** Auto-retry budget for transport-closed errors, reset on every successful `result`. */
  private transportErrorRetryCount = 0;
  private recapEmitted = false;

  // --- state surface for a reaper / UI, per ADR-0002 §3 ---
  private _turnInFlight = false;
  private _pendingInteractiveCallbacks = 0;
  private _lastActivityAt = Date.now();

  /** True while a turn is in flight — replaces `ThreadManager.isRunning()`'s old two-map check. */
  get turnInFlight(): boolean {
    return this._turnInFlight;
  }

  /**
   * True while a `canUseTool` round-trip (permission prompt, AskUserQuestion,
   * ExitPlanMode, ...) is awaiting a human response. No longer a release gate
   * (there is nothing left to gate — see ADR-0002 §2) but preserved as a
   * plain state flag: useful for UI ("waiting on you") and for a reaper to
   * avoid closing a session out from under a pending human decision.
   */
  get hasPendingPermission(): boolean {
    return this._pendingInteractiveCallbacks > 0;
  }

  /** Timestamp (ms) of the last `send()` or the last message-pump activity. */
  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  /**
   * Whether an idle reaper may safely close this session right now. Does NOT
   * know about scheduled wake-ups (cron / orchestrator) — that's a
   * `ThreadManager`-level concern per ADR-0002 §3; this only reports the
   * session's own busy/idle state.
   */
  canIdleReap(): boolean {
    return !this._turnInFlight && !this.hasPendingPermission;
  }

  /** `!turnInFlight`, per ADR-0002 §2's interface sketch. */
  isIdle(): boolean {
    return !this._turnInFlight;
  }

  constructor(private claudePath: string) {}

  // ------------------------------------------------------------------
  // Push channel: the held-open async generator handed to query() once,
  // generalized from ClaudeSession's single-turn version (ClaudeSession.ts
  // :313-335) to run for the thread's full lifetime instead of one turn.
  // ------------------------------------------------------------------

  private openChannel(): void {
    this.pushQueue = [];
    this.pushWaiters = [];
    this.channelEnded = false;
  }

  private pushToChannel(message: SDKUserMessage): void {
    if (this.channelEnded) {
      throw new Error('[ClaudeThreads] ThreadSession.send() called on a closed channel — call start()/restart() first');
    }
    const waiter = this.pushWaiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
    } else {
      this.pushQueue.push(message);
    }
  }

  /** Idempotent: completes the generator, letting the SDK see EOF on stdin. */
  private endChannel(): void {
    if (this.channelEnded) return;
    this.channelEnded = true;
    while (this.pushWaiters.length > 0) {
      this.pushWaiters.shift()!({ value: undefined, done: true });
    }
  }

  private createChannel(): AsyncIterable<SDKUserMessage> {
    const session = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, undefined> {
        return {
          next(): Promise<IteratorResult<SDKUserMessage, undefined>> {
            if (session.pushQueue.length > 0) {
              return Promise.resolve({ value: session.pushQueue.shift()!, done: false });
            }
            if (session.channelEnded) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => {
              session.pushWaiters.push(resolve);
            });
          },
        };
      },
    };
  }

  // ------------------------------------------------------------------
  // Public lifecycle
  // ------------------------------------------------------------------

  /**
   * Builds `Options` once and opens the thread's long-lived `Query`. Does not
   * send any content by itself — callers push the first (and every
   * subsequent) turn via `send()`. Intended to be called lazily, on the
   * thread's first message, per ADR-0002 §3.
   */
  async start(options: ThreadSessionOptions): Promise<void> {
    if (this.query) {
      throw new Error('[ClaudeThreads] ThreadSession.start() called while a Query is already open — call close() or restart() first');
    }
    this.currentOptions = options;
    this.lastKnownSessionId = options.resume;
    this.interrupted = false;
    this.recapEmitted = false;
    this._turnInFlight = false;
    this._pendingInteractiveCallbacks = 0;
    this._lastActivityAt = Date.now();
    this.openChannel();

    const callbacks = options.callbacks;

    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      this._pendingInteractiveCallbacks++;
      try {
        if (toolName === 'AskUserQuestion') {
          const questions = (input as { questions: import('./types').AskQuestion[] }).questions;
          const answers = await callbacks.onAskUserQuestion(questions);
          return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
        }
        if (toolName === 'OpenNewTab') {
          const inp = input as { title?: string; initialPrompt?: string };
          const result = await callbacks.onOpenNewTab(inp.title, inp.initialPrompt);
          return { behavior: 'allow' as const, updatedInput: { ...input, result: JSON.stringify(result) } };
        }
        if (toolName === 'EnterPlanMode') {
          callbacks.onEnterPlanMode?.();
          return { behavior: 'allow' as const };
        }
        if (toolName === 'ExitPlanMode') {
          // See ClaudeSession.ts's identical block for the full rationale
          // (Zod schema rejects the extra `plan` field; deny + setPermissionMode
          // is how approval/rejection is actually communicated back to the CLI).
          const clearPlanMode = async () => {
            try {
              await this.query?.setPermissionMode('default');
            } catch (err) {
              console.error('[ClaudeThreads] failed to clear plan mode via setPermissionMode:', err);
            }
          };
          const planText = String((input as { plan?: unknown }).plan ?? '');
          if (callbacks.onPlanReady) {
            const result = await new Promise<import('@anthropic-ai/claude-agent-sdk').PermissionResult>((resolve) => {
              callbacks.onPlanReady!(
                planText,
                async (editedPlan) => {
                  await clearPlanMode();
                  const approvalNote = editedPlan !== undefined && editedPlan !== planText
                    ? `Plan approved with edits:\n\n${editedPlan}`
                    : 'Plan approved — proceed with implementation.';
                  resolve({ behavior: 'deny' as const, message: approvalNote, interrupt: false });
                },
                () => resolve({ behavior: 'deny' as const, message: 'Plan rejected by user — stop immediately and do not proceed with any implementation.', interrupt: false }),
              );
            });
            return result;
          }
          await clearPlanMode();
          return { behavior: 'deny' as const, message: 'Plan approved — proceed with implementation.', interrupt: false };
        }
        const detail = opts.description ?? opts.decisionReason ?? opts.blockedPath ?? JSON.stringify(input).slice(0, 120);
        const title = opts.title ?? toolName;
        const allowed = await callbacks.onPermissionRequest(title, detail);
        return allowed
          ? { behavior: 'allow' as const, updatedInput: input, ...(opts.suggestions ? { updatedPermissions: opts.suggestions } : {}) }
          : { behavior: 'deny' as const, message: 'Denied by user' };
      } catch (err) {
        console.error('[ClaudeThreads] canUseTool error:', err);
        return { behavior: 'deny' as const, message: 'Permission handler error' };
      } finally {
        this._pendingInteractiveCallbacks--;
      }
    };

    const sdkOptions: Options = {
      pathToClaudeCodeExecutable: this.claudePath,
      permissionMode: options.permissionMode,
      cwd: options.cwd,
      includePartialMessages: true,
      canUseTool,
      env: { ...process.env, ...parseExtraEnv(options.extraEnvRaw), ...(options.secretEnv ?? {}) },
    };
    if (options.resume) sdkOptions.resume = options.resume;
    if (options.additionalDirectories?.length) sdkOptions.additionalDirectories = options.additionalDirectories;
    if (options.model) sdkOptions.model = options.model;
    if (options.appendSystemPrompt) sdkOptions.extraArgs = { 'append-system-prompt': options.appendSystemPrompt };
    if (options.mcpServers && Object.keys(options.mcpServers).length) {
      sdkOptions.mcpServers = options.mcpServers;
      const mcpDebug = Object.entries(options.mcpServers).map(([k, v]) => ({
        serverName: k,
        type: (v as unknown as Record<string, unknown>).type,
        hasInstance: 'instance' in v,
      }));
      debugLog('[ClaudeThreads] MCP servers attached to thread session:', JSON.stringify(mcpDebug));
    } else {
      console.warn('[ClaudeThreads] No MCP servers for this thread session — Obsidian tools will be unavailable');
    }
    if (options.disallowedTools?.length) sdkOptions.disallowedTools = options.disallowedTools;
    if (options.sessionOptions?.thinking) sdkOptions.thinking = options.sessionOptions.thinking;
    if (options.sessionOptions?.effort) sdkOptions.effort = options.sessionOptions.effort;
    if (options.sessionOptions?.agentProgressSummaries !== undefined) sdkOptions.agentProgressSummaries = options.sessionOptions.agentProgressSummaries;
    if (options.sessionOptions?.betas?.length) sdkOptions.betas = options.sessionOptions.betas;
    if (options.sessionOptions?.persistSession === false) sdkOptions.persistSession = false;
    if (options.sessionOptions?.plugins?.length) sdkOptions.plugins = options.sessionOptions.plugins;
    if (options.sessionOptions?.agents && Object.keys(options.sessionOptions.agents).length > 0) {
      sdkOptions.agents = { ...sdkOptions.agents, ...options.sessionOptions.agents };
    }
    if (callbacks.onElicitation) {
      sdkOptions.onElicitation = (request, opts) => callbacks.onElicitation!(request, opts.signal);
    }
    sdkOptions.toolAliases = {
      EnterWorktree: 'mcp__obsidian__enter_worktree',
      ExitWorktree: 'mcp__obsidian__exit_worktree',
    };

    debugLog('[ClaudeThreads] opening thread session', {
      claudePath: this.claudePath,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      resume: options.resume,
      model: options.model ?? 'default',
    });

    const promptArg = this.createChannel();

    let q: Query;
    try {
      q = query({ prompt: promptArg, options: sdkOptions });
    } catch (initErr) {
      console.error('[ClaudeThreads] ThreadSession query() init failed:', initErr);
      this.channelEnded = true;
      callbacks.onError(initErr instanceof Error ? initErr : new Error(String(initErr)));
      return;
    }
    this.query = q;

    if (callbacks.onCapabilitiesDiscovered) {
      Promise.all([
        q.supportedModels().catch(() => []),
        q.supportedAgents().catch(() => []),
      ]).then(([models, agents]) => {
        callbacks.onCapabilitiesDiscovered?.(models, agents);
      }).catch(() => { /* ignore */ });
    }

    // Marker for the raw JSONL log. Unlike ClaudeSession's per-turn version,
    // this fires once per underlying Query spawn (start()/restart()), not
    // once per user-authored turn — there's no longer a 1:1 turn<->spawn
    // relationship to key it off (ADR-0002 §2's coalescing note).
    callbacks.onRawEvent?.({
      type: 'session_start',
      resume: options.resume ?? null,
      cwd: options.cwd,
      model: options.model ?? null,
      permissionMode: options.permissionMode ?? null,
      timestamp: Date.now(),
    });

    // Message pump runs detached — start() resolves once the Query exists,
    // it does not block for the thread's lifetime the way ClaudeSession.run()
    // blocked for one turn's lifetime.
    void this.pumpMessages(q, callbacks);
  }

  /**
   * Pushes a turn onto the open channel. Safe to call unconditionally,
   * including while a turn is already in flight or a `canUseTool` callback is
   * mid-flight — confirmed against the live CLI (ADR-0002 §2). There is no
   * internal queue-and-wait: the CLI coalesces a concurrent push into the
   * generation already running.
   */
  send(text: string, images?: ImageAttachment[]): void {
    if (!this.query) {
      throw new Error('[ClaudeThreads] ThreadSession.send() called before start() (or after close())');
    }
    const message: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: images && images.length > 0
          ? [
              ...(text.trim() ? [{ type: 'text' as const, text }] : []),
              ...images.map(img => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: img.mediaType,
                  data: img.base64,
                },
              })),
            ]
          : text,
      },
    };
    this.pushToChannel(message);
    this._turnInFlight = true;
    this._lastActivityAt = Date.now();
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.query) {
      await this.query.interrupt();
    }
  }

  /** No restart needed — a direct control-request on the live Query (ADR-0002 §2). */
  async setModel(model?: string): Promise<void> {
    if (!this.query) {
      throw new Error('[ClaudeThreads] ThreadSession.setModel() called before start()');
    }
    await this.query.setModel(model);
  }

  /** No restart needed — a direct control-request on the live Query (ADR-0002 §2). */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.query) {
      throw new Error('[ClaudeThreads] ThreadSession.setPermissionMode() called before start()');
    }
    await this.query.setPermissionMode(mode);
  }

  /**
   * Returns a snapshot of current context window usage from the live query.
   * Returns null when no session is open or the call fails.
   */
  async getContextUsage(): Promise<import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse | null> {
    if (!this.query) return null;
    try {
      return await this.query.getContextUsage();
    } catch {
      return null;
    }
  }

  /**
   * `close()` then `start()` again, resuming from the last known SDK session
   * id (except for `'cwd-change'`, where resuming is unsafe by construction —
   * a resumed session can't cross Claude Code project directories, see
   * ADR-0002 §2's "cwd changes" paragraph — so a cwd-change restart always
   * starts fresh).
   *
   * `overrideOptions`, if given, fully replaces the options used for the new
   * `start()` call (e.g. a caller updating `cwd`/`appendSystemPrompt` for a
   * `'cwd-change'` restart) rather than reusing whatever `start()` was last
   * called with. This is a deliberate small addition beyond ADR-0002 §2's
   * interface sketch (`restart(reason)`, no second parameter): without it,
   * a `'cwd-change'` restart would have no way to actually change the `cwd`
   * it reopens with, which contradicts the ADR's own stated cwd-change
   * invariant. Omit it to just resume in place (transport-error /
   * init-options-change).
   */
  async restart(reason: RestartReason, overrideOptions?: ThreadSessionOptions): Promise<void> {
    const baseOptions = overrideOptions ?? this.currentOptions;
    if (!baseOptions) {
      throw new Error('[ClaudeThreads] ThreadSession.restart() called before start()');
    }
    const resume = reason === 'cwd-change'
      ? undefined
      : (this.lastKnownSessionId ?? baseOptions.resume);
    this.close();
    await this.start({ ...baseOptions, resume });
  }

  /** Completes the channel and closes the live Query, if any. Idempotent. */
  close(): void {
    this.endChannel();
    if (this.query) {
      try {
        this.query.close();
      } catch (err) {
        console.error('[ClaudeThreads] ThreadSession.close(): q.close() failed:', err);
      }
      this.query = null;
    }
    this._turnInFlight = false;
  }

  // ------------------------------------------------------------------
  // Message pump — the switch(msg.type) body moved from ClaudeSession.run(),
  // largely unchanged (ADR-0002 §2), minus the release-gate machinery that
  // no longer has anything to gate: pendingBgTaskIds,
  // sawTaskNotificationSinceLastResult, and the three-condition releaseInput()
  // check are deleted outright, per ADR-0002 §2 ("Deleted outright" list).
  // ------------------------------------------------------------------

  private async pumpMessages(q: Query, callbacks: SessionCallbacks): Promise<void> {
    // Set when this generation is being superseded by an internal
    // transport-error auto-retry restart, so the `finally` block below
    // doesn't clobber the NEW Query that restart() already installed.
    let supersededByRestart = false;

    const pendingToolCalls: ToolCallRecord[] = [];
    let streamingText = '';
    const allToolCalls: ToolCallRecord[] = [];
    const toolCallsByUseId = new Map<string, ToolCallRecord>();
    const pendingTaskCreates = new Map<string, string>();

    try {
      for await (const msg of q) {
        debugLog('[ClaudeThreads] msg.type:', msg.type, (msg as Record<string, unknown>).subtype ?? '');
        if (callbacks.onRawEvent && msg.type !== 'stream_event') {
          callbacks.onRawEvent(msg as { type?: string } & Record<string, unknown>);
        }
        switch (msg.type) {
          case 'stream_event': {
            const evt = msg.event;
            if (evt.type === 'content_block_delta') {
              const delta = evt.delta as { type: string; text?: string };
              if (delta.type === 'text_delta' && delta.text) {
                streamingText += delta.text;
                callbacks.onToken(delta.text);
              }
            }
            break;
          }

          case 'assistant': {
            const parts: string[] = [];
            for (const block of msg.message.content) {
              if (block.type === 'text') {
                parts.push(block.text);
              } else if (block.type === 'tool_use') {
                const summary = formatToolSummary(
                  block.name,
                  block.input as Record<string, unknown>,
                );
                const record: ToolCallRecord = { name: block.name, summary, timestamp: Date.now(), toolUseId: block.id, status: 'pending' };
                pendingToolCalls.push(record);
                allToolCalls.push(record);
                toolCallsByUseId.set(block.id, record);
                callbacks.onToolUse(record);

                if (callbacks.onTaskEvent) {
                  const input = block.input as Record<string, unknown>;
                  if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
                    const tasks = (input.todos as Array<Record<string, unknown>>)
                      .filter(t => typeof t.content === 'string')
                      .map(t => ({
                        content: t.content as string,
                        status: (t.status as import('./types').TaskItemStatus) ?? 'pending',
                      }));
                    callbacks.onTaskEvent({ kind: 'replace', tasks });
                  } else if (block.name === 'TaskCreate' && typeof input.subject === 'string') {
                    pendingTaskCreates.set(block.id, input.subject);
                  } else if (block.name === 'TaskUpdate' && input.taskId != null) {
                    callbacks.onTaskEvent({
                      kind: 'update',
                      id: String(input.taskId),
                      status: typeof input.status === 'string' ? input.status : undefined,
                      content: typeof input.subject === 'string' ? input.subject : undefined,
                    });
                  }
                }
              }
            }
            if (parts.length > 0) {
              const content = parts.join('\n');
              callbacks.onMessage(content, [...pendingToolCalls]);
            }
            pendingToolCalls.length = 0;
            streamingText = '';
            break;
          }

          case 'tool_use_summary': {
            this.recapEmitted = true;
            callbacks.onRecap(msg.summary);
            break;
          }

          case 'result': {
            this._lastActivityAt = Date.now();
            if (msg.subtype === 'success') {
              this.lastKnownSessionId = msg.session_id;
              this.transportErrorRetryCount = 0;
              if (allToolCalls.length > 0 && !this.recapEmitted) {
                const names = [...new Set(allToolCalls.map(t => formatToolName(t.name)))];
                callbacks.onRecap(`Used ${names.join(', ')} (${allToolCalls.length} call${allToolCalls.length > 1 ? 's' : ''})`);
              }
              callbacks.onDone(msg.session_id, msg.total_cost_usd, msg.num_turns);
            } else if (this.interrupted) {
              callbacks.onInterrupted(this.lastKnownSessionId ?? '');
            } else {
              callbacks.onError(
                new Error(`Claude session ended: ${(msg as { subtype: string }).subtype}`),
              );
            }
            // No release-gate here (ADR-0002 §2) — the channel stays open
            // regardless of this result; it only closes when close()/restart()
            // says so. A `result` just marks the turn done.
            this._turnInFlight = false;
            break;
          }

          case 'system': {
            const sys = msg as Record<string, unknown>;
            switch (sys.subtype) {
              case 'status':
                callbacks.onStatus?.(sys.status as 'compacting' | 'requesting' | null);
                break;
              case 'compact_boundary': {
                const meta = sys.compact_metadata as { trigger: 'auto' | 'manual'; pre_tokens: number } | undefined;
                callbacks.onCompact?.(meta?.trigger ?? 'auto', meta?.pre_tokens ?? 0);
                break;
              }
              case 'task_started':
                callbacks.onTaskStarted?.(
                  sys.task_id as string,
                  sys.description as string,
                  !!(sys.skip_transcript),
                  sys.task_type as string | undefined,
                  sys.workflow_name as string | undefined,
                  sys.subagent_type as string | undefined,
                );
                break;
              case 'task_updated': {
                const patch = sys.patch as Record<string, unknown>;
                callbacks.onTaskUpdated?.(
                  sys.task_id as string,
                  {
                    status: patch.status as string | undefined,
                    description: patch.description as string | undefined,
                    error: patch.error as string | undefined,
                  }
                );
                break;
              }
              case 'task_progress':
                callbacks.onTaskProgress?.(
                  sys.task_id as string,
                  sys.description as string,
                  sys.last_tool_name as string | undefined,
                );
                if (sys.summary && callbacks.onTaskProgressSummary) {
                  callbacks.onTaskProgressSummary(sys.task_id as string, sys.summary as string);
                }
                break;
              case 'task_notification':
                callbacks.onTaskNotification?.(
                  sys.task_id as string,
                  sys.status as 'completed' | 'failed' | 'stopped',
                  sys.summary as string,
                );
                break;
              case 'notification':
                callbacks.onNotification?.(
                  sys.text as string,
                  sys.priority as 'low' | 'medium' | 'high' | 'immediate',
                );
                break;
              case 'api_retry':
                callbacks.onApiRetry?.(
                  sys.attempt as number,
                  sys.max_retries as number,
                  sys.error as string,
                );
                break;
              case 'model_fallback':
                callbacks.onModelFallback?.(
                  sys.trigger as string,
                  sys.from_model as string,
                  sys.to_model as string,
                );
                break;
              case 'memory_recall': {
                const paths = ((sys.memories as Array<{ path: string }>) ?? []).map(m => m.path);
                callbacks.onMemoryRecall?.(paths, sys.mode as 'select' | 'synthesize');
                break;
              }
              case 'commands_changed':
                callbacks.onCommandsChanged?.(
                  sys.commands as import('@anthropic-ai/claude-agent-sdk').SlashCommand[],
                );
                break;
              case 'session_state_changed':
                // Confirmed available in the pinned SDK version (ADR-0002 §1)
                // but not yet adopted as the authoritative busy/idle signal —
                // that's an explicit open question in the ADR (§ Open
                // Questions #5), deferred pending Rick's sign-off. Logged for
                // now so the signal is observable without changing
                // `turnInFlight` semantics underneath ThreadManager.
                debugLog('[ClaudeThreads] session_state_changed:', (sys as { state?: string }).state);
                break;
            }
            break;
          }

          case 'tool_progress': {
            const tp = msg as Record<string, unknown>;
            callbacks.onToolProgress?.(
              tp.tool_use_id as string,
              tp.tool_name as string,
              tp.elapsed_time_seconds as number,
            );
            break;
          }

          case 'rate_limit_event': {
            const rle = msg as Record<string, unknown>;
            const info = rle.rate_limit_info as Record<string, unknown>;
            callbacks.onRateLimit?.(
              info.status as 'allowed' | 'allowed_warning' | 'rejected',
              info.resetsAt as number | undefined,
            );
            break;
          }

          case 'user': {
            const userMsg = msg as Record<string, unknown>;
            const msgContent = (userMsg.message as Record<string, unknown>)?.content;
            if (Array.isArray(msgContent)) {
              for (const block of msgContent) {
                const b = block as Record<string, unknown>;
                if (b.type !== 'tool_result') continue;

                {
                  const toolUseId = b.tool_use_id as string | undefined;
                  const record = toolUseId ? toolCallsByUseId.get(toolUseId) : undefined;
                  if (record) {
                    const status: 'success' | 'error' = b.is_error === true ? 'error' : 'success';
                    record.status = status;
                    if (record.timestamp) {
                      record.durationMs = Date.now() - record.timestamp;
                    }
                    callbacks.onToolResult?.(toolUseId!, status, record.durationMs);
                  }
                }

                if (callbacks.onToolResultImages && Array.isArray(b.content)) {
                  const images: Array<{ mediaType: string; data: string }> = [];
                  for (const inner of b.content as Array<Record<string, unknown>>) {
                    if (inner.type === 'image') {
                      const src = inner.source as Record<string, unknown>;
                      if (src?.type === 'base64' && src.data && src.media_type) {
                        images.push({ mediaType: src.media_type as string, data: src.data as string });
                      }
                    }
                  }
                  if (images.length > 0) callbacks.onToolResultImages(images);
                }

                if (callbacks.onGitOperation) {
                  const resultRaw = b.tool_result ?? b.content;
                  let parsedResult: Record<string, unknown> | null = null;
                  try {
                    if (typeof resultRaw === 'string') {
                      parsedResult = JSON.parse(resultRaw) as Record<string, unknown>;
                    } else if (resultRaw && typeof resultRaw === 'object') {
                      parsedResult = resultRaw as Record<string, unknown>;
                    }
                  } catch { /* non-JSON tool result — skip */ }
                  if (parsedResult?.gitOperation) {
                    const op = parsedResult.gitOperation as Record<string, unknown>;
                    const parts: string[] = [];
                    if (op.commit) {
                      const c = op.commit as Record<string, unknown>;
                      parts.push(`${c.kind ?? 'committed'} ${String(c.sha ?? '').substring(0, 7)}`);
                    }
                    if (op.push) {
                      const p = op.push as Record<string, unknown>;
                      parts.push(`pushed to ${p.branch}`);
                    }
                    if (op.branch) {
                      const br = op.branch as Record<string, unknown>;
                      parts.push(`${br.action} ${br.ref}`);
                    }
                    if (op.pr) {
                      const pr = op.pr as Record<string, unknown>;
                      const prDesc = pr.url ? `PR #${pr.number} ${pr.action}` : `PR #${pr.number} ${pr.action}`;
                      parts.push(prDesc);
                    }
                    if (parts.length > 0) {
                      callbacks.onGitOperation(`git: ${parts.join(', ')}`);
                    }
                  }
                }

                if (callbacks.onFileUserModified) {
                  const resultRaw = b.tool_result ?? b.content;
                  let parsedResult: Record<string, unknown> | null = null;
                  try {
                    if (typeof resultRaw === 'string') {
                      parsedResult = JSON.parse(resultRaw) as Record<string, unknown>;
                    } else if (resultRaw && typeof resultRaw === 'object') {
                      parsedResult = resultRaw as Record<string, unknown>;
                    }
                  } catch { /* non-JSON tool result — skip */ }
                  if (parsedResult?.userModified === true && typeof parsedResult.filePath === 'string') {
                    callbacks.onFileUserModified(parsedResult.filePath);
                  }
                }

                const toolUseId = b.tool_use_id as string | undefined;
                if (toolUseId && pendingTaskCreates.has(toolUseId)) {
                  const subject = pendingTaskCreates.get(toolUseId)!;
                  pendingTaskCreates.delete(toolUseId);
                  const text = typeof b.content === 'string'
                    ? b.content
                    : Array.isArray(b.content)
                      ? (b.content as Array<Record<string, unknown>>)
                          .map(c => (typeof c.text === 'string' ? c.text : ''))
                          .join(' ')
                      : '';
                  const idMatch = text.match(/Task #(\d+)/i);
                  if (idMatch) {
                    callbacks.onTaskEvent?.({ kind: 'create', id: idMatch[1], content: subject });
                  }
                }
              }
            }
            break;
          }
        }
      }
    } catch (err) {
      if (this.interrupted) {
        callbacks.onInterrupted(this.lastKnownSessionId ?? '');
      } else {
        const e = err instanceof Error ? err : new Error(String(err));
        // Transport-error retry (ADR-0002 §2): reuse transportErrorRecovery.ts's
        // existing trigger logic unchanged, rather than re-deriving the
        // "stream closed" detection here. "Process died → respawn with resume"
        // becomes an internal restart() + a continuation turn, invisible to
        // the caller unless the retry budget is exhausted.
        if (isTransportClosedError(e.message) && shouldAutoRetryTransportError(e.message, this.transportErrorRetryCount)) {
          this.transportErrorRetryCount++;
          supersededByRestart = true;
          // Fire onReconnecting at the exact point that used to be
          // ThreadManager.sendMessage()'s `thread.status = 'reconnecting'`
          // branch under the old per-turn model (see ClaudeSession's
          // SessionCallbacks.onReconnecting doc comment) — right before the
          // restart that will silently open a new Query and re-send the
          // continuation prompt, so the UI gets the same "hang on,
          // recovering" signal it used to get, even though the retry itself
          // is now entirely internal to ThreadSession.
          callbacks.onReconnecting?.(e.message);
          try {
            await this.restart('transport-error');
            this.send(TRANSPORT_ERROR_CONTINUATION_PROMPT);
          } catch (restartErr) {
            console.error('[ClaudeThreads] ThreadSession transport-error auto-retry failed:', restartErr);
            callbacks.onError(restartErr instanceof Error ? restartErr : new Error(String(restartErr)));
          }
        } else {
          const zodIssues = (err as Record<string, unknown>).issues;
          console.error('[ClaudeThreads] ThreadSession pump error:', e, zodIssues ? JSON.stringify(zodIssues, null, 2) : '');
          callbacks.onError(new Error(`${e.message}${zodIssues ? '\n\nZod issues: ' + JSON.stringify(zodIssues) : ''}\n\nStack: ${e.stack ?? 'none'}`));
        }
      }
    } finally {
      this.interrupted = false;
      if (!supersededByRestart) {
        // This generation ended on its own (not via an internal restart,
        // which already closed/reopened this.query) — tear the whole session
        // down. A future send() requires an explicit start()/restart() again,
        // mirroring ClaudeSession's finally, which always nulled activeQuery.
        // Guarded by `!supersededByRestart` (rather than unconditional, as an
        // earlier version had it): restart() already called send() for the
        // new generation before we get here, which sets _turnInFlight = true
        // for that new turn — resetting it unconditionally would stomp that
        // back to false while a genuinely new turn is in flight.
        this._turnInFlight = false;
        // Only close/null this.query if it's still THIS generation's q — an
        // external close() may have already closed it (and installed null)
        // before this loop noticed the channel ended, in which case q is
        // already closed and closing it again would just log a spurious error.
        if (this.query === q) {
          try {
            q.close();
          } catch (closeErr) {
            console.error('[ClaudeThreads] ThreadSession: q.close() in pump finally failed:', closeErr);
          }
          this.query = null;
        }
        this.endChannel();
      }
    }
  }
}

function formatToolSummary(name: string, input: Record<string, unknown>): string {
  // Duplicated verbatim from ClaudeSession.ts (not exported there, and Stage
  // B leaves ClaudeSession.ts untouched — see the file-level comment above).
  // Normalize MCP tool names so the switch cases below always match bare names.
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  const bare = mcpMatch ? mcpMatch[1] : name;
  const server = mcpMatch ? name.match(/^mcp__([^_]+)__/)![1] : null;
  const key = (server && bare.startsWith(server + '_'))
    ? bare.slice(server.length + 1)
    : bare;

  switch (key) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'Glob':
    case 'Grep':
      return `${String(input.file_path ?? input.path ?? input.pattern ?? '')}`;
    case 'Bash':
      return `${String(input.command ?? '').substring(0, 60)}`;
    case 'REPL': {
      const code = String(input.code ?? '');
      const firstLine = code.split('\n')[0].trim();
      return `Run JS: ${firstLine.substring(0, 60)}`;
    }
    case 'WebFetch':
      return `${input.url}`;
    case 'WebSearch':
      return `${input.query}`;
    case 'Agent':
      return String(input.description ?? input.prompt ?? '').substring(0, 80);
    case 'OpenNewTab':
      return `${(input.title as string) ?? 'New Thread'}`;
    case 'navigate_to_file': return `${input.path}`;
    case 'search_vault': return `${input.query}`;
    case 'get_backlinks': return `${input.path}`;
    case 'get_outgoing_links': return `${input.path}`;
    case 'insert_at_cursor': return '';
    case 'get_note_metadata': return `${input.path}`;
    case 'set_working_directory': return `${input.path}`;
    default:
      return '';
  }
}

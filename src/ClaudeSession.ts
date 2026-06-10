import { query, type Options, type Query, type CanUseTool, type SDKUserMessage, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { ToolCallRecord, AskQuestion, ImageAttachment, TaskItemStatus } from './types';
import { parseExtraEnv } from './types';
import { debugLog } from './logger';
// Import from the mobile-safe utility module, then re-export so that desktop
// callers that already import formatToolName/getToolIcon from ClaudeSession
// continue to work without changes.
import { formatToolName, getToolIcon } from './toolNameUtils';
export { formatToolName, getToolIcon };

/**
 * Incremental change to Claude Code's task list, derived from the agent's
 * task-tracking tool calls:
 * - 'replace' — TodoWrite (older CLIs) sends the whole list each time
 * - 'create'  — TaskCreate confirmed by its tool result ("Task #N created…")
 * - 'update'  — TaskUpdate sets status (and possibly a new subject)
 */
export type TaskTrackerEvent =
  | { kind: 'replace'; tasks: { content: string; status: TaskItemStatus }[] }
  | { kind: 'create'; id: string; content: string }
  | { kind: 'update'; id: string; status?: string; content?: string };

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
  /** Fired when the agent's task list changes (TodoWrite / TaskCreate / TaskUpdate). */
  onTaskEvent?: (event: TaskTrackerEvent) => void;
}

export class ClaudeSession {
  private activeQuery: Query | null = null;
  private recapEmitted = false;
  private interrupted = false;
  private resumeSessionId: string | undefined = undefined;

  constructor(private claudePath: string) {}

  async run(
    prompt: string,
    resumeSessionId: string | undefined,
    cwd: string,
    permissionMode: Options['permissionMode'],
    extraEnvRaw: string,
    callbacks: SessionCallbacks,
    additionalDirectories?: string[],
    model?: string,
    images?: ImageAttachment[],
    appendSystemPrompt?: string,
    mcpServers?: Record<string, McpServerConfig>,
    secretEnv?: Record<string, string>,
    disallowedTools?: string[],
  ): Promise<void> {
    this.interrupted = false;
    this.resumeSessionId = resumeSessionId;

    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      try {
        if (toolName === 'AskUserQuestion') {
          const questions = (input as { questions: import('./types').AskQuestion[] }).questions;
          const answers = await callbacks.onAskUserQuestion(questions);
          // Spread original input to preserve metadata/annotations, then override answers
          return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
        }
        if (toolName === 'OpenNewTab') {
          const inp = input as { title?: string; initialPrompt?: string };
          const result = await callbacks.onOpenNewTab(inp.title, inp.initialPrompt);
          return { behavior: 'allow' as const, updatedInput: { ...input, result: JSON.stringify(result) } };
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
      }
    };

    const options: Options = {
      pathToClaudeCodeExecutable: this.claudePath,
      permissionMode,
      cwd,
      includePartialMessages: true,
      canUseTool,
      env: { ...process.env, ...parseExtraEnv(extraEnvRaw), ...(secretEnv ?? {}) },
    };
    if (resumeSessionId) options.resume = resumeSessionId;
    if (additionalDirectories?.length) options.additionalDirectories = additionalDirectories;
    if (model) options.model = model;
    if (appendSystemPrompt) options.extraArgs = { 'append-system-prompt': appendSystemPrompt };
    if (mcpServers && Object.keys(mcpServers).length) {
      options.mcpServers = mcpServers;
      const mcpDebug = Object.entries(mcpServers).map(([k, v]) => ({
        serverName: k,
        type: (v as unknown as Record<string, unknown>).type,
        hasInstance: 'instance' in v,
      }));
      debugLog('[ClaudeThreads] MCP servers attached to session:', JSON.stringify(mcpDebug));
    } else {
      console.warn('[ClaudeThreads] No MCP servers for this session — Obsidian tools will be unavailable');
    }
    if (disallowedTools?.length) options.disallowedTools = disallowedTools;

    debugLog('[ClaudeThreads] launching query', { claudePath: this.claudePath, cwd, permissionMode, resume: resumeSessionId, model: model ?? 'default' });

    const promptArg: string | AsyncIterable<SDKUserMessage> =
      images && images.length > 0
        ? (async function* () {
            yield {
              type: 'user' as const,
              parent_tool_use_id: null,
              message: {
                role: 'user' as const,
                content: [
                  ...(prompt.trim() ? [{ type: 'text' as const, text: prompt }] : []),
                  ...images.map(img => ({
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: img.mediaType,
                      data: img.base64,
                    },
                  })),
                ],
              },
            };
          })()
        : prompt;

    let q: Query;
    try {
      q = query({ prompt: promptArg, options });
    } catch (initErr) {
      console.error('[ClaudeThreads] query() init failed:', initErr);
      callbacks.onError(initErr instanceof Error ? initErr : new Error(String(initErr)));
      return;
    }
    this.activeQuery = q;

    const pendingToolCalls: ToolCallRecord[] = [];
    let streamingText = '';

    const allToolCalls: ToolCallRecord[] = [];
    // TaskCreate tool_use ids → subject, awaiting the "Task #N created" result
    // so the create event carries the CLI-assigned task id.
    const pendingTaskCreates = new Map<string, string>();

    try {
      for await (const msg of q) {
        debugLog('[ClaudeThreads] msg.type:', msg.type, (msg as Record<string, unknown>).subtype ?? '');
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
                const record: ToolCallRecord = { name: block.name, summary, timestamp: Date.now() };
                pendingToolCalls.push(record);
                allToolCalls.push(record);
                callbacks.onToolUse(record);

                // Task-tracking tools — surface as task list updates
                if (callbacks.onTaskEvent) {
                  const input = block.input as Record<string, unknown>;
                  if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
                    const tasks = (input.todos as Array<Record<string, unknown>>)
                      .filter(t => typeof t.content === 'string')
                      .map(t => ({
                        content: t.content as string,
                        status: (t.status as TaskItemStatus) ?? 'pending',
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
            if (msg.subtype === 'success') {
              // Fallback recap from tool calls if no tool_use_summary was emitted
              if (allToolCalls.length > 0 && !this.recapEmitted) {
                const names = [...new Set(allToolCalls.map(t => formatToolName(t.name)))];
                callbacks.onRecap(`Used ${names.join(', ')} (${allToolCalls.length} call${allToolCalls.length > 1 ? 's' : ''})`);
              }
              callbacks.onDone(msg.session_id, msg.total_cost_usd, msg.num_turns);
            } else if (this.interrupted) {
              // User-initiated stop — Claude Code reports error_during_execution when
              // interrupted; treat this as a clean cancellation, not a real error.
              callbacks.onInterrupted(this.resumeSessionId ?? '');
            } else {
              callbacks.onError(
                new Error(`Claude session ended: ${(msg as { subtype: string }).subtype}`),
              );
            }
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
                );
                break;
              case 'task_progress':
                callbacks.onTaskProgress?.(
                  sys.task_id as string,
                  sys.description as string,
                  sys.last_tool_name as string | undefined,
                );
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
            }
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
            // Tool results come back as 'user' messages. parent_tool_use_id is null
            // even for tool results, so scan content unconditionally.
            const userMsg = msg as Record<string, unknown>;
            const msgContent = (userMsg.message as Record<string, unknown>)?.content;
            if (Array.isArray(msgContent)) {
              for (const block of msgContent) {
                const b = block as Record<string, unknown>;
                if (b.type !== 'tool_result') continue;

                // Inline images returned by tools (e.g. Read on a PNG)
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

                // TaskCreate confirmation — "Task #N created successfully: <subject>"
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
        // Clean cancellation — notify the manager so it can roll back the orphaned user message
        callbacks.onInterrupted(this.resumeSessionId ?? '');
      } else {
        const e = err instanceof Error ? err : new Error(String(err));
        const zodIssues = (err as Record<string, unknown>).issues;
        console.error('[ClaudeThreads] session error:', e, zodIssues ? JSON.stringify(zodIssues, null, 2) : '');
        callbacks.onError(new Error(`${e.message}${zodIssues ? '\n\nZod issues: ' + JSON.stringify(zodIssues) : ''}\n\nStack: ${e.stack ?? 'none'}`));
      }
    } finally {
      this.interrupted = false;
      this.activeQuery = null;
      // Explicitly close the query so the SDK removes the subprocess wrapper from its
      // internal tracking Set (w7) and detaches exit/error listeners. Without this call,
      // every completed query leaks its ChildProcess wrapper and the closure chain it
      // holds (options.env copy, callbacks, MCP server config) until the parent process
      // exits. On a day of heavy use with many queries this accumulates into tens of MB
      // of heap that is never collected.
      q.close();
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.activeQuery) {
      await this.activeQuery.interrupt();
    }
  }

  close(): void {
    if (this.activeQuery) {
      this.activeQuery.close();
      this.activeQuery = null;
    }
  }
}


function formatToolSummary(name: string, input: Record<string, unknown>): string {
  // Normalize MCP tool names so the switch cases below always match bare names
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

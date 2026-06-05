/**
 * AnthropicProvider — drives the Anthropic Claude Agent SDK.
 *
 * This is the original ClaudeSession logic extracted into the AIProvider
 * interface. Capabilities: full — streaming, session resumption, tool
 * permission gating, MCP servers, vision input, Opus escalation.
 *
 * No code execution via container tool (Claude Code handles its own sandboxing
 * through the subprocess; no explicit code_interpreter capability needed here).
 */

import { query, type Options, type Query, type CanUseTool, type SDKUserMessage, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { ToolCallRecord, AskQuestion, ImageAttachment } from '../types';
import { parseExtraEnv } from '../types';
import { debugLog } from '../logger';
import { formatToolName, formatToolSummary, getToolIcon } from '../toolNameUtils';
import type { AIProvider, ProviderCapabilities, RunOptions, SessionCallbacks } from './AIProvider';

export { formatToolName, getToolIcon };

export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  sessionResumption: true,
  toolPermissionGating: true,
  mcpServers: true,
  visionInput: true,
  codeExecution: false,
  opusEscalation: true,
};

export class AnthropicProvider implements AIProvider {
  private activeQuery: Query | null = null;
  private recapEmitted = false;
  private interrupted = false;
  private resumeSessionId: string | undefined = undefined;

  readonly capabilities: ProviderCapabilities = ANTHROPIC_CAPABILITIES;

  constructor(private claudePath: string) {}

  async run(opts: RunOptions): Promise<void> {
    const {
      prompt,
      resumeSessionId,
      cwd,
      permissionMode,
      extraEnvRaw,
      callbacks,
      additionalDirectories,
      model,
      images,
      appendSystemPrompt,
      mcpServers,
      secretEnv,
    } = opts;

    this.interrupted = false;
    this.resumeSessionId = resumeSessionId;
    this.recapEmitted = false;

    const canUseTool: CanUseTool = async (toolName, input, toolOpts) => {
      try {
        if (toolName === 'AskUserQuestion') {
          const questions = (input as { questions: AskQuestion[] }).questions;
          const answers = await callbacks.onAskUserQuestion(questions);
          return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
        }
        if (toolName === 'OpenNewTab') {
          const inp = input as { title?: string; initialPrompt?: string };
          const result = await callbacks.onOpenNewTab(inp.title, inp.initialPrompt);
          return { behavior: 'allow' as const, updatedInput: { ...input, result: JSON.stringify(result) } };
        }
        const detail = toolOpts.description ?? toolOpts.decisionReason ?? toolOpts.blockedPath ?? JSON.stringify(input).slice(0, 120);
        const title = toolOpts.title ?? toolName;
        const allowed = await callbacks.onPermissionRequest(title, detail);
        return allowed
          ? { behavior: 'allow' as const, updatedInput: input, ...(toolOpts.suggestions ? { updatedPermissions: toolOpts.suggestions } : {}) }
          : { behavior: 'deny' as const, message: 'Denied by user' };
      } catch (err) {
        console.error('[ClaudeThreads] canUseTool error:', err);
        return { behavior: 'deny' as const, message: 'Permission handler error' };
      }
    };

    const options: Options = {
      pathToClaudeCodeExecutable: this.claudePath,
      permissionMode: permissionMode as Options['permissionMode'],
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
                const summary = formatToolSummary(block.name, block.input as Record<string, unknown>);
                const record: ToolCallRecord = { name: block.name, summary, timestamp: Date.now() };
                pendingToolCalls.push(record);
                allToolCalls.push(record);
                callbacks.onToolUse(record);
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
              if (allToolCalls.length > 0 && !this.recapEmitted) {
                const names = [...new Set(allToolCalls.map(t => formatToolName(t.name)))];
                callbacks.onRecap(`Used ${names.join(', ')} (${allToolCalls.length} call${allToolCalls.length > 1 ? 's' : ''})`);
              }
              callbacks.onDone(msg.session_id, msg.total_cost_usd, msg.num_turns);
            } else if (this.interrupted) {
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
        }
      }
    } catch (err) {
      if (this.interrupted) {
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

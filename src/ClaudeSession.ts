import { query, type Options, type Query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ToolCallRecord, AskQuestion } from './types';
import { parseExtraEnv } from './types';

export interface SessionCallbacks {
  onToken: (text: string) => void;
  onToolUse: (record: ToolCallRecord) => void;
  onMessage: (content: string, toolCalls: ToolCallRecord[]) => void;
  onRecap: (summary: string) => void;
  onDone: (sessionId: string, cost: number, numTurns: number) => void;
  onError: (err: Error) => void;
  onPermissionRequest: (toolName: string, detail: string) => Promise<boolean>;
  onAskUserQuestion: (questions: AskQuestion[]) => Promise<Record<string, string>>;
}

export class ClaudeSession {
  private activeQuery: Query | null = null;
  private recapEmitted = false;

  constructor(private claudePath: string) {}

  async run(
    prompt: string,
    resumeSessionId: string | undefined,
    cwd: string,
    permissionMode: Options['permissionMode'],
    extraEnvRaw: string,
    callbacks: SessionCallbacks,
    additionalDirectories?: string[],
  ): Promise<void> {
    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      try {
        if (toolName === 'AskUserQuestion') {
          const questions = (input as { questions: import('./types').AskQuestion[] }).questions;
          const answers = await callbacks.onAskUserQuestion(questions);
          // Spread original input to preserve metadata/annotations, then override answers
          return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
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
      env: { ...process.env, ...parseExtraEnv(extraEnvRaw) },
    };
    if (resumeSessionId) options.resume = resumeSessionId;
    if (additionalDirectories?.length) options.additionalDirectories = additionalDirectories;

    console.log('[ClaudeThreads] launching query', { claudePath: this.claudePath, cwd, permissionMode, resume: resumeSessionId });

    let q: Query;
    try {
      q = query({ prompt, options });
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
        console.log('[ClaudeThreads] msg.type:', msg.type, (msg as Record<string, unknown>).subtype ?? '');
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
                const record: ToolCallRecord = { name: block.name, summary };
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
              // Fallback recap from tool calls if no tool_use_summary was emitted
              if (allToolCalls.length > 0 && !this.recapEmitted) {
                const names = [...new Set(allToolCalls.map(t => t.name))];
                callbacks.onRecap(`Used ${names.join(', ')} (${allToolCalls.length} call${allToolCalls.length > 1 ? 's' : ''})`);
              }
              callbacks.onDone(msg.session_id, msg.total_cost_usd, msg.num_turns);
            } else {
              callbacks.onError(
                new Error(`Claude session ended: ${(msg as { subtype: string }).subtype}`),
              );
            }
            break;
          }
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Log full ZodError detail including .issues if present
      const zodIssues = (err as Record<string, unknown>).issues;
      console.error('[ClaudeThreads] session error:', e, zodIssues ? JSON.stringify(zodIssues, null, 2) : '');
      callbacks.onError(new Error(`${e.message}${zodIssues ? '\n\nZod issues: ' + JSON.stringify(zodIssues) : ''}\n\nStack: ${e.stack ?? 'none'}`));
    } finally {
      this.activeQuery = null;
    }
  }

  async interrupt(): Promise<void> {
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
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'Glob':
    case 'Grep':
      return `${name}: ${input.file_path ?? input.path ?? input.pattern ?? ''}`;
    case 'Bash':
      return `Bash: ${String(input.command ?? '').substring(0, 60)}`;
    case 'WebFetch':
      return `Fetch: ${input.url}`;
    case 'WebSearch':
      return `Search: ${input.query}`;
    default:
      return name;
  }
}

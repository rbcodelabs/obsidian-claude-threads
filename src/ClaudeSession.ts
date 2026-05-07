import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { ToolCallRecord } from './types';

export interface SessionCallbacks {
  onToken: (text: string) => void;
  onToolUse: (record: ToolCallRecord) => void;
  onMessage: (content: string, toolCalls: ToolCallRecord[]) => void;
  onDone: (sessionId: string, cost: number, numTurns: number) => void;
  onError: (err: Error) => void;
}

export class ClaudeSession {
  private activeQuery: Query | null = null;

  constructor(private claudePath: string) {}

  async run(
    prompt: string,
    resumeSessionId: string | undefined,
    cwd: string,
    permissionMode: Options['permissionMode'],
    callbacks: SessionCallbacks,
  ): Promise<void> {
    const options: Options = {
      pathToClaudeCodeExecutable: this.claudePath,
      permissionMode,
      cwd,
      includePartialMessages: true,
    };
    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

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

    try {
      for await (const msg of q) {
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

          case 'result': {
            if (msg.subtype === 'success') {
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
      console.error('[ClaudeThreads] session error:', e);
      // Surface full error for diagnosis
      callbacks.onError(new Error(`${e.message}\n\nStack: ${e.stack ?? 'none'}`));
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

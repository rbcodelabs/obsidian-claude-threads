import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'os';
import type { ChatMessage } from './types';
import { parseExtraEnv } from './types';

type ProgressCallback = (status: string) => void;

export class InProcessSummarizer {
  async summarize(
    messages: ChatMessage[],
    claudeBinaryPath: string,
    modelAlias: string,
    extraEnv: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const transcript = messages
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 600)}`)
      .join('\n\n')
      .slice(0, 3000);

    const prompt =
      'Below is a conversation transcript inside <transcript> tags. ' +
      'Output a 2-3 sentence summary of it covering what is being worked on, key decisions, ' +
      'and current status. Be specific about files, projects, or tasks mentioned. ' +
      'Do not use any tools. Output only the summary — no preamble.\n\n' +
      `<transcript>\n${transcript}\n</transcript>\n\nSummary:`;

    onProgress?.('Summarizing…');

    let result = '';

    console.log('[Claude Threads] summarize: starting query, model=', modelAlias, 'transcript length=', transcript.length);
    for await (const msg of query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: claudeBinaryPath,
        permissionMode: 'default',
        model: modelAlias,
        cwd: os.tmpdir(),
        env: { ...process.env, ...parseExtraEnv(extraEnv) },
      },
    })) {
      console.log('[Claude Threads] summarize msg.type:', msg.type);
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') result = block.text;
        }
      }
    }

    console.log('[Claude Threads] summarize result:', result.slice(0, 100));
    return result.trim();
  }

  unload(): void {}
}

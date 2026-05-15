import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'os';
import type { ChatMessage } from './types';
import { parseExtraEnv } from './types';

type ProgressCallback = (status: string) => void;

export interface SummarizeResult {
  title: string;
  summary: string;
}

export class InProcessSummarizer {
  async summarize(
    messages: ChatMessage[],
    claudeBinaryPath: string,
    modelAlias: string,
    extraEnv: string,
    onProgress?: ProgressCallback,
  ): Promise<SummarizeResult> {
    const transcript = messages
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 600)}`)
      .join('\n\n')
      .slice(0, 3000);

    const prompt =
      'Below is a conversation transcript inside <transcript> tags. ' +
      'Output a JSON object with exactly two fields:\n' +
      '- "title": a 3-5 word tab title for the conversation (be specific, e.g. "Fix auth middleware bug")\n' +
      '- "summary": a 2-3 sentence summary covering what is being worked on, key decisions, and current status\n\n' +
      'Output ONLY the JSON object, no markdown fences, no other text.\n\n' +
      `<transcript>\n${transcript}\n</transcript>`;

    onProgress?.('Summarizing…');

    let raw = '';

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
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') raw = block.text;
        }
      }
    }

    return parseJsonResult(raw.trim());
  }

  async generateForkPrompt(
    messages: ChatMessage[],
    focus: string,
    claudeBinaryPath: string,
    modelAlias: string,
    extraEnv: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    // Filter out compact markers, take last 30 messages, 800 chars each, max 6000 total
    const relevantMessages = messages.filter(m => m.role !== 'compact');
    const transcript = relevantMessages
      .slice(-30)
      .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 800)}`)
      .join('\n\n')
      .slice(0, 6000);

    const focusClause = focus.trim()
      ? `The user wants the new thread to focus on: "${focus.trim()}"`
      : 'The user wants to continue and extend the work from this conversation in a new clean thread.';

    const prompt =
      'You are helping fork a conversation into a new, self-contained thread.\n\n' +
      'Conversation transcript:\n<transcript>\n' + transcript + '\n</transcript>\n\n' +
      focusClause + '\n\n' +
      'Generate a comprehensive starting message for the new thread. Requirements:\n' +
      '1. Distill the relevant context: what was decided, which files are involved, current state\n' +
      '2. Be written as a direct, actionable request — as if starting fresh\n' +
      '3. Do NOT write "based on our previous conversation" or "as we discussed"\n' +
      '4. Include specific details: file paths, decisions made, code snippets where relevant\n' +
      '5. Be self-contained so the new thread can stand completely alone\n\n' +
      'Output ONLY the starting message. No preamble, no explanation, no markdown fences.';

    onProgress?.('Generating fork prompt…');

    let result = '';

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
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') result = block.text;
        }
      }
    }

    return result.trim();
  }

  unload(): void {}
}

function parseJsonResult(text: string): SummarizeResult {
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      title: String(parsed.title ?? '').trim(),
      summary: String(parsed.summary ?? '').trim(),
    };
  } catch {
    // Fallback: treat whole text as summary, no title
    return { title: '', summary: text };
  }
}

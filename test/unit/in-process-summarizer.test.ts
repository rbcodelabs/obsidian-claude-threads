import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../../src/types';

// Must be hoisted above the import of InProcessSummarizer so vi.mock runs first
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { InProcessSummarizer } from '../../src/InProcessSummarizer';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = query as ReturnType<typeof vi.fn>;

async function* mockQueryResult(text: string) {
  yield {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp: Date.now() };
}

describe('InProcessSummarizer.generateForkPrompt', () => {
  let summarizer: InProcessSummarizer;

  beforeEach(() => {
    summarizer = new InProcessSummarizer();
    mockQuery.mockReset();
  });

  it('returns the generated text from the assistant message', async () => {
    const expected = 'Fix the JWT validation bug in src/auth/jwt.ts.';
    mockQuery.mockReturnValue(mockQueryResult(expected));

    const messages = [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi')];
    const result = await summarizer.generateForkPrompt(messages, '', '/usr/bin/claude', 'haiku', '');

    expect(result).toBe(expected);
  });

  it('filters out compact-role messages from the transcript', async () => {
    let capturedPrompt = '';
    mockQuery.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return mockQueryResult('result');
    });

    const messages = [
      makeMessage('user', 'Hello'),
      makeMessage('compact', '[Compacted context]'),
      makeMessage('assistant', 'Hi there'),
    ];

    await summarizer.generateForkPrompt(messages, '', '/usr/bin/claude', 'haiku', '');

    expect(capturedPrompt).not.toContain('[Compacted context]');
    expect(capturedPrompt).toContain('Hello');
    expect(capturedPrompt).toContain('Hi there');
  });

  it('includes the focus text in the prompt when provided', async () => {
    let capturedPrompt = '';
    mockQuery.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return mockQueryResult('result');
    });

    const messages = [makeMessage('user', 'Hello')];
    await summarizer.generateForkPrompt(messages, 'fix the login bug', '/usr/bin/claude', 'haiku', '');

    expect(capturedPrompt).toContain('"fix the login bug"');
  });

  it('uses a "continue and extend the work" clause when focus is empty', async () => {
    let capturedPrompt = '';
    mockQuery.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return mockQueryResult('result');
    });

    const messages = [makeMessage('user', 'Hello')];
    await summarizer.generateForkPrompt(messages, '', '/usr/bin/claude', 'haiku', '');

    expect(capturedPrompt).toContain('continue and extend the work');
  });

  it('calls onProgress with "Generating fork prompt…"', async () => {
    mockQuery.mockReturnValue(mockQueryResult('result'));

    const onProgress = vi.fn();
    const messages = [makeMessage('user', 'Hello')];
    await summarizer.generateForkPrompt(messages, '', '/usr/bin/claude', 'haiku', '', onProgress);

    expect(onProgress).toHaveBeenCalledWith('Generating fork prompt…');
  });

  it('trims leading and trailing whitespace from the result', async () => {
    mockQuery.mockReturnValue(mockQueryResult('  \n  Fix the bug.  \n  '));

    const messages = [makeMessage('user', 'Hello')];
    const result = await summarizer.generateForkPrompt(messages, '', '/usr/bin/claude', 'haiku', '');

    expect(result).toBe('Fix the bug.');
  });
});

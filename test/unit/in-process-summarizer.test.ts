import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../../src/types';

// Must be hoisted above the import of InProcessSummarizer so vi.mock runs first
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import {
  InProcessSummarizer,
  parseJsonResult,
  getSummarizerQueryCount,
  resetSummarizerQueryCount,
} from '../../src/InProcessSummarizer';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = query as ReturnType<typeof vi.fn>;

async function* mockQueryResult(text: string) {
  yield {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

function makeMessage(role: ChatMessage['role'], content: string, timestamp = Date.now()): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp };
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

describe('InProcessSummarizer.summarize', () => {
  let summarizer: InProcessSummarizer;

  beforeEach(() => {
    summarizer = new InProcessSummarizer();
    mockQuery.mockReset();
  });

  it('returns correct title and summary from a valid JSON response', async () => {
    mockQuery.mockReturnValue(mockQueryResult('{"title":"Fix auth","summary":"Fixes JWT validation"}'));

    const messages = [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi')];
    const result = await summarizer.summarize(messages, '/usr/bin/claude', 'haiku', '');

    expect(result).toEqual({ title: 'Fix auth', summary: 'Fixes JWT validation' });
  });

  it('strips markdown fences and parses correctly', async () => {
    const fenced = '```json\n{"title":"Fix auth","summary":"Fixes JWT validation"}\n```';
    mockQuery.mockReturnValue(mockQueryResult(fenced));

    const messages = [makeMessage('user', 'Hello')];
    const result = await summarizer.summarize(messages, '/usr/bin/claude', 'haiku', '');

    expect(result).toEqual({ title: 'Fix auth', summary: 'Fixes JWT validation' });
  });

  it('returns no update for a non-JSON response instead of storing the raw text', async () => {
    // Previously this stored the model's prose (including refusals like
    // "I don't have enough context…") as the thread's persisted summary.
    mockQuery.mockReturnValue(mockQueryResult('not json at all'));

    const messages = [makeMessage('user', 'Hello')];
    const result = await summarizer.summarize(messages, '/usr/bin/claude', 'haiku', '');

    expect(result).toEqual({ title: '', summary: '' });
  });

  it('calls onProgress with "Summarizing…"', async () => {
    mockQuery.mockReturnValue(mockQueryResult('{"title":"t","summary":"s"}'));

    const onProgress = vi.fn();
    const messages = [makeMessage('user', 'Hello')];
    await summarizer.summarize(messages, '/usr/bin/claude', 'haiku', '', onProgress);

    expect(onProgress).toHaveBeenCalledWith('Summarizing…');
  });

  it('includes the prior title and summary as context on the full path', async () => {
    let capturedPrompt = '';
    mockQuery.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return mockQueryResult('{"title":"t","summary":"s"}');
    });

    const messages = [makeMessage('user', 'Hello')];
    await summarizer.summarize(
      messages, '/usr/bin/claude', 'haiku', '', undefined,
      'We are fixing the auth middleware.', undefined, 'Fix auth middleware',
    );

    expect(capturedPrompt).toContain('Fix auth middleware');
    expect(capturedPrompt).toContain('We are fixing the auth middleware.');
  });

  it('sends only the delta on the incremental path, filtering empty messages', async () => {
    let capturedPrompt = '';
    mockQuery.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return mockQueryResult('{"title":"t","summary":"s"}');
    });

    const messages = [
      makeMessage('user', 'OLD CONTENT', 100),
      makeMessage('assistant', '', 300),
      makeMessage('assistant', 'NEW CONTENT', 400),
    ];
    await summarizer.summarize(
      messages, '/usr/bin/claude', 'haiku', '', undefined, 'prior summary', 200,
    );

    expect(capturedPrompt).toContain('NEW CONTENT');
    expect(capturedPrompt).toContain('prior summary');
    expect(capturedPrompt).not.toContain('OLD CONTENT');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Subprocess isolation.
//
// Every summarizer call spawns a `claude` subprocess. Without these options the
// SDK loads all filesystem setting sources ("when omitted, all sources are
// loaded") and boots the user's entire MCP server roster as child processes for
// a one-sentence title generation.
// ───────────────────────────────────────────────────────────────────────────
describe('InProcessSummarizer subprocess isolation', () => {
  let summarizer: InProcessSummarizer;
  let capturedOptions: Record<string, unknown>;

  beforeEach(() => {
    summarizer = new InProcessSummarizer();
    mockQuery.mockReset();
    capturedOptions = {};
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      capturedOptions = options;
      return mockQueryResult('{"title":"t","summary":"s"}');
    });
  });

  function expectIsolated() {
    expect(capturedOptions.settingSources).toEqual([]);
    expect(capturedOptions.mcpServers).toEqual({});
    expect(capturedOptions.strictMcpConfig).toBe(true);
    // `tools: []` disables all built-in tools. `allowedTools` is an
    // auto-approve list, NOT a restriction — using it here would be a no-op.
    expect(capturedOptions.tools).toEqual([]);
    expect(capturedOptions).not.toHaveProperty('allowedTools');
    expect(capturedOptions.maxTurns).toBe(1);
  }

  it('isolates the summarize() path', async () => {
    await summarizer.summarize([makeMessage('user', 'Hello')], '/usr/bin/claude', 'haiku', '');
    expectIsolated();
  });

  it('isolates the incremental summarize path', async () => {
    const messages = [makeMessage('user', 'Hello', 100), makeMessage('assistant', 'Hi', 300)];
    await summarizer.summarize(messages, '/usr/bin/claude', 'haiku', '', undefined, 'prior', 200);
    expectIsolated();
  });

  it('isolates the summarizeMessage() path', async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      capturedOptions = options;
      return mockQueryResult('one sentence');
    });
    await summarizer.summarizeMessage('Some assistant output', '/usr/bin/claude', 'haiku', '');
    expectIsolated();
  });

  it('isolates the generateForkPrompt() path', async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      capturedOptions = options;
      return mockQueryResult('fork prompt');
    });
    await summarizer.generateForkPrompt([makeMessage('user', 'Hello')], '', '/usr/bin/claude', 'haiku', '');
    expectIsolated();
  });

  it('still passes the caller-supplied binary, model and cwd', async () => {
    await summarizer.summarize([makeMessage('user', 'Hello')], '/usr/bin/claude', 'haiku', '');
    expect(capturedOptions.pathToClaudeCodeExecutable).toBe('/usr/bin/claude');
    expect(capturedOptions.model).toBe('haiku');
    expect(typeof capturedOptions.cwd).toBe('string');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Regression for the live "Transcript empty" thread found in data.json:
// 21 messages, the last 20 of which are tool-only assistant messages with
// empty content. The old code sliced to the last 20 BEFORE filtering, so the
// model received `Claude: \n\nClaude: \n\n…` and titled the thread from it.
// ───────────────────────────────────────────────────────────────────────────
describe('InProcessSummarizer empty-transcript regression', () => {
  let summarizer: InProcessSummarizer;

  beforeEach(() => {
    summarizer = new InProcessSummarizer();
    mockQuery.mockReset();
    resetSummarizerQueryCount();
  });

  /** 21 messages: one real user message, then 20 empty tool-only assistant messages. */
  function liveFailingThread(): ChatMessage[] {
    return [
      makeMessage('user', 'Add a caching layer to the API client', 1000),
      ...Array.from({ length: 20 }, (_, i) => makeMessage('assistant', '', 1001 + i)),
    ];
  }

  it('never calls query() when every recent message is empty', async () => {
    const messages = Array.from({ length: 21 }, (_, i) => makeMessage('assistant', '', 1000 + i));
    const result = await summarizer.summarize(messages, '/usr/bin/claude', 'haiku', '');

    expect(mockQuery).not.toHaveBeenCalled();
    expect(getSummarizerQueryCount()).toBe(0);
    expect(result).toEqual({ title: '', summary: '' });
  });

  it('produces no title change from an all-empty transcript', async () => {
    const messages = Array.from({ length: 21 }, (_, i) => makeMessage('assistant', '', 1000 + i));
    const { title } = await summarizer.summarize(messages, '/usr/bin/claude', 'haiku', '');
    expect(title).toBe('');
  });

  it('recovers the one real message that the old slice-then-filter order evicted', async () => {
    let capturedPrompt = '';
    mockQuery.mockImplementation(({ prompt }: { prompt: string }) => {
      capturedPrompt = prompt;
      return mockQueryResult('{"title":"Add API caching layer","summary":"Adding a cache."}');
    });

    const result = await summarizer.summarize(liveFailingThread(), '/usr/bin/claude', 'haiku', '');

    expect(capturedPrompt).toContain('Add a caching layer to the API client');
    expect(capturedPrompt).not.toContain('Claude: \n\nClaude:');
    expect(result.title).toBe('Add API caching layer');
  });

  it('skips the model on the incremental path when the delta is all empty messages', async () => {
    const messages = [
      makeMessage('user', 'Add a caching layer', 1000),
      ...Array.from({ length: 20 }, (_, i) => makeMessage('assistant', '', 2000 + i)),
    ];
    // Prior summary + cutoff after the real message → incremental path, empty delta,
    // then the full path, whose transcript still has the one real message.
    mockQuery.mockReturnValue(mockQueryResult('{"title":"Add API caching","summary":"s"}'));
    await summarizer.summarize(messages, '/usr/bin/claude', 'haiku', '', undefined, 'prior', 1500);

    const prompt = mockQuery.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Add a caching layer');
    expect(getSummarizerQueryCount()).toBe(1);
  });
});

describe('parseJsonResult', () => {
  it('parses a plain JSON object', () => {
    expect(parseJsonResult('{"title":"T","summary":"S"}')).toEqual({ title: 'T', summary: 'S' });
  });

  it('treats the NO_SUMMARY sentinel as no update', () => {
    expect(parseJsonResult('NO_SUMMARY')).toEqual({ title: '', summary: '' });
    expect(parseJsonResult('  no_summary  ')).toEqual({ title: '', summary: '' });
  });

  it('strips the sentinel out of individual JSON fields', () => {
    expect(parseJsonResult('{"title":"NO_SUMMARY","summary":"NO_SUMMARY"}'))
      .toEqual({ title: '', summary: '' });
  });

  it('treats an empty response as no update', () => {
    expect(parseJsonResult('')).toEqual({ title: '', summary: '' });
    expect(parseJsonResult('   ')).toEqual({ title: '', summary: '' });
  });

  it('does not turn a model refusal into the thread summary', () => {
    const refusal = "I'm sorry, I don't have enough context to summarize this conversation.";
    expect(parseJsonResult(refusal)).toEqual({ title: '', summary: '' });
  });

  it('still strips markdown fences', () => {
    expect(parseJsonResult('```json\n{"title":"T","summary":"S"}\n```'))
      .toEqual({ title: 'T', summary: 'S' });
  });
});

describe('summarizer query counter (spawn instrumentation)', () => {
  let summarizer: InProcessSummarizer;

  beforeEach(() => {
    summarizer = new InProcessSummarizer();
    mockQuery.mockReset();
    mockQuery.mockReturnValue(mockQueryResult('{"title":"t","summary":"s"}'));
    resetSummarizerQueryCount();
  });

  it('counts one spawn per model-backed call', async () => {
    expect(getSummarizerQueryCount()).toBe(0);
    await summarizer.summarize([makeMessage('user', 'Hello')], '/usr/bin/claude', 'haiku', '');
    expect(getSummarizerQueryCount()).toBe(1);
    await summarizer.summarize([makeMessage('user', 'Hello again')], '/usr/bin/claude', 'haiku', '');
    expect(getSummarizerQueryCount()).toBe(2);
  });

  it('counts zero spawns for content that short-circuits', async () => {
    await summarizer.summarize([makeMessage('assistant', '')], '/usr/bin/claude', 'haiku', '');
    await summarizer.summarizeMessage('   ', '/usr/bin/claude', 'haiku', '');
    expect(getSummarizerQueryCount()).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

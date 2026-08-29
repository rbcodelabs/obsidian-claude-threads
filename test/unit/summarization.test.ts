import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../src/types';
import {
  buildTranscript,
  hasNewSummarizableContent,
  isUsableTitle,
  shouldAutoSummarize,
  summarizableMessages,
  MAX_AUTO_TITLE_LENGTH,
} from '../../src/summarization';

let seq = 0;
function msg(role: ChatMessage['role'], content: string, timestamp = ++seq): ChatMessage {
  return { id: `m${timestamp}`, role, content, timestamp };
}

describe('summarizableMessages', () => {
  it('drops compact-role messages', () => {
    const out = summarizableMessages([
      msg('user', 'Hello'),
      msg('compact', '[Compacted context]'),
    ]);
    expect(out.map((m) => m.content)).toEqual(['Hello']);
  });

  it('drops empty and whitespace-only content (the tool-only assistant messages)', () => {
    const out = summarizableMessages([
      msg('assistant', ''),
      msg('assistant', '   \n  '),
      msg('assistant', 'Real text'),
    ]);
    expect(out.map((m) => m.content)).toEqual(['Real text']);
  });
});

describe('buildTranscript', () => {
  const opts = { maxMessages: 20, maxCharsPerMessage: 600, maxTotalChars: 3000 };

  it('labels user and assistant turns', () => {
    const out = buildTranscript([msg('user', 'Hi'), msg('assistant', 'Hello')], opts);
    expect(out).toBe('User: Hi\n\nClaude: Hello');
  });

  it('filters BEFORE slicing so real content is not evicted by empty messages', () => {
    // The live bug: 21 messages where the last 20 are empty. Slicing first
    // discarded the only message with content.
    const messages = [
      msg('user', 'Fix the auth middleware bug'),
      ...Array.from({ length: 20 }, () => msg('assistant', '')),
    ];
    const out = buildTranscript(messages, opts);
    expect(out).toBe('User: Fix the auth middleware bug');
  });

  it('returns an empty string when nothing survives filtering', () => {
    const messages = Array.from({ length: 20 }, () => msg('assistant', ''));
    expect(buildTranscript(messages, opts)).toBe('');
  });

  it('keeps only the most recent maxMessages after filtering', () => {
    const messages = Array.from({ length: 5 }, (_, i) => msg('user', `m${i}`));
    const out = buildTranscript(messages, { ...opts, maxMessages: 2 });
    expect(out).toBe('User: m3\n\nUser: m4');
  });

  it('truncates each message to maxCharsPerMessage', () => {
    const out = buildTranscript([msg('user', 'abcdef')], { ...opts, maxCharsPerMessage: 3 });
    expect(out).toBe('User: abc');
  });

  it('caps the joined transcript at maxTotalChars', () => {
    const out = buildTranscript([msg('user', 'abcdef')], { ...opts, maxTotalChars: 8 });
    expect(out).toBe('User: ab');
  });

  it('applies the `since` cutoff', () => {
    const messages = [msg('user', 'old', 100), msg('user', 'new', 200)];
    expect(buildTranscript(messages, { ...opts, since: 150 })).toBe('User: new');
  });

  it('returns empty when the only messages after `since` are empty-content', () => {
    const messages = [msg('user', 'old', 100), msg('assistant', '', 200)];
    expect(buildTranscript(messages, { ...opts, since: 150 })).toBe('');
  });
});

describe('hasNewSummarizableContent', () => {
  it('is true for any message when there is no prior cursor', () => {
    expect(hasNewSummarizableContent([msg('user', 'Hi', 100)])).toBe(true);
  });

  it('is false when every message predates the cursor', () => {
    expect(hasNewSummarizableContent([msg('user', 'Hi', 100)], 200)).toBe(false);
  });

  it('is false when the only newer messages are tool-only (empty content)', () => {
    const messages = [msg('user', 'Hi', 100), msg('assistant', '', 300)];
    expect(hasNewSummarizableContent(messages, 200)).toBe(false);
  });

  it('is true when a newer message has real content', () => {
    const messages = [msg('user', 'Hi', 100), msg('assistant', 'Done', 300)];
    expect(hasNewSummarizableContent(messages, 200)).toBe(true);
  });

  it('is false for an empty message list', () => {
    expect(hasNewSummarizableContent([])).toBe(false);
  });
});

describe('isUsableTitle', () => {
  it('accepts a normal title', () => {
    expect(isUsableTitle('Fix auth middleware bug')).toBe(true);
  });

  it('rejects empty and whitespace-only titles', () => {
    expect(isUsableTitle('')).toBe(false);
    expect(isUsableTitle('   ')).toBe(false);
  });

  it('rejects the exact title that shipped from the live bug', () => {
    expect(isUsableTitle('Transcript empty')).toBe(false);
  });

  it('rejects meta-commentary titles', () => {
    for (const bad of ['Empty conversation', 'No content provided', 'N/A', 'Unknown', 'Untitled']) {
      expect(isUsableTitle(bad), bad).toBe(false);
    }
  });

  it(`rejects titles longer than ${MAX_AUTO_TITLE_LENGTH} characters`, () => {
    expect(isUsableTitle('x'.repeat(MAX_AUTO_TITLE_LENGTH))).toBe(true);
    expect(isUsableTitle('x'.repeat(MAX_AUTO_TITLE_LENGTH + 1))).toBe(false);
  });

  it('does not reject legitimate titles that merely contain a banned word', () => {
    expect(isUsableTitle('Parse transcript output')).toBe(true);
    expect(isUsableTitle('Node cache empty on boot')).toBe(true);
  });
});

describe('shouldAutoSummarize', () => {
  const base = {
    summarizationEnabled: true,
    autoSummarize: false,
    titleUserSet: false,
    inFlight: false,
    messages: [msg('user', 'Hi', 100)],
    lastSummarizedAt: undefined as number | undefined,
  };

  it('fires on a completed turn with new content and an auto-generated title', () => {
    expect(shouldAutoSummarize(base)).toBe(true);
  });

  it('never fires when summarization is disabled', () => {
    expect(shouldAutoSummarize({ ...base, summarizationEnabled: false })).toBe(false);
  });

  it('never fires while a call is already in flight for the thread', () => {
    expect(shouldAutoSummarize({ ...base, inFlight: true })).toBe(false);
  });

  it('stops firing once the user renames the thread (autoSummarize off — the default)', () => {
    expect(shouldAutoSummarize({ ...base, titleUserSet: true })).toBe(false);
  });

  it('keeps firing after a user rename when autoSummarize is on', () => {
    expect(shouldAutoSummarize({ ...base, titleUserSet: true, autoSummarize: true })).toBe(true);
  });

  it('skips when no new content has arrived since the last summarization', () => {
    expect(shouldAutoSummarize({ ...base, lastSummarizedAt: 200 })).toBe(false);
  });

  it('skips when the only new messages are tool-only (empty content)', () => {
    expect(shouldAutoSummarize({
      ...base,
      messages: [msg('user', 'Hi', 100), msg('assistant', '', 300)],
      lastSummarizedAt: 200,
    })).toBe(false);
  });

  it('fires when new content arrived after the last summarization', () => {
    expect(shouldAutoSummarize({
      ...base,
      messages: [msg('user', 'Hi', 100), msg('assistant', 'Fixed it', 300)],
      lastSummarizedAt: 200,
    })).toBe(true);
  });

  it('skips a thread whose entire history is tool-only messages', () => {
    expect(shouldAutoSummarize({
      ...base,
      messages: Array.from({ length: 20 }, () => msg('assistant', '')),
    })).toBe(false);
  });
});

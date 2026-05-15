import { describe, it, expect } from 'vitest';
import {
  buildMessageWithAttachment,
  deriveDispatchTitle,
  MAX_ATTACHMENT_BYTES,
} from '../../src/attachmentUtils';

// ---------------------------------------------------------------------------
// buildMessageWithAttachment
// ---------------------------------------------------------------------------

describe('buildMessageWithAttachment', () => {
  it('returns text unchanged when there is no attachment', () => {
    expect(buildMessageWithAttachment('hello', null)).toBe('hello');
  });

  it('returns a single space when both text and attachment are empty', () => {
    expect(buildMessageWithAttachment('', null)).toBe(' ');
  });

  it('wraps attachment in a code fence when there is no text', () => {
    const result = buildMessageWithAttachment('', 'data.json\n{"a":1}');
    expect(result).toBe('```\ndata.json\n{"a":1}\n```');
  });

  it('appends fenced attachment after text with a blank-line separator', () => {
    const result = buildMessageWithAttachment('analyse this', 'data.json\n{"a":1}');
    expect(result).toBe('analyse this\n\n```\ndata.json\n{"a":1}\n```');
  });

  it('does not double-wrap if attachment already contains backticks', () => {
    // We do NOT sanitise the content — that is Claude's job. Just confirm
    // the outer fence is always added regardless.
    const attachment = 'notes.md\n```inner block```';
    const result = buildMessageWithAttachment('', attachment);
    expect(result.startsWith('```\n')).toBe(true);
    expect(result.endsWith('\n```')).toBe(true);
  });

  it('trims nothing — preserves leading/trailing newlines in attachment', () => {
    const attachment = 'file.txt\n\nline1\nline2\n';
    const result = buildMessageWithAttachment('', attachment);
    expect(result).toBe(`\`\`\`\n${attachment}\n\`\`\``);
  });
});

// ---------------------------------------------------------------------------
// deriveDispatchTitle
// ---------------------------------------------------------------------------

describe('deriveDispatchTitle', () => {
  it('uses typed text when present', () => {
    expect(deriveDispatchTitle('Refactor the auth module', null, 0))
      .toBe('Refactor the auth module');
  });

  it('truncates typed text to 50 characters', () => {
    const long = 'A'.repeat(60);
    expect(deriveDispatchTitle(long, null, 0)).toBe('A'.repeat(50));
  });

  it('uses the filename (first line of attachment) when text is empty', () => {
    expect(deriveDispatchTitle('', 'schema.json\n{"x":1}', 0))
      .toBe('schema.json');
  });

  it('prefers typed text over attachment filename', () => {
    expect(deriveDispatchTitle('My task', 'schema.json\n{}', 0))
      .toBe('My task');
  });

  it('falls back to image count label when no text and no attachment', () => {
    expect(deriveDispatchTitle('', null, 1)).toBe('Image task (1 image)');
    expect(deriveDispatchTitle('', null, 3)).toBe('Image task (3 images)');
  });

  it('falls back to "New Thread" when everything is absent', () => {
    expect(deriveDispatchTitle('', null, 0)).toBe('New Thread');
  });

  it('ignores image count when typed text is present', () => {
    expect(deriveDispatchTitle('Deploy fix', null, 5)).toBe('Deploy fix');
  });

  it('trims whitespace-only text and falls back to attachment', () => {
    expect(deriveDispatchTitle('   ', 'config.ts\nexport {}', 0))
      .toBe('config.ts');
  });
});

// ---------------------------------------------------------------------------
// MAX_ATTACHMENT_BYTES
// ---------------------------------------------------------------------------

describe('MAX_ATTACHMENT_BYTES', () => {
  it('is 500 000 bytes (500 KB)', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(500_000);
  });
});

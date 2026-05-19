import { describe, it, expect } from 'vitest';
import type { ChatMessage, Thread } from '../../src/types';

// ── Helpers mirrored from ThreadManager / ThreadsView ──────────────────────

/**
 * Mirrors the PR URL extraction logic in ThreadManager.onMessage and the
 * lazy-scan fallback in ThreadsView.refreshStatusLine.
 */
const PR_URL_RE = /https:\/\/github\.com\/[^\s>)"']+\/pull\/\d+/;

function extractPrUrl(content: string): string | undefined {
  return content.match(PR_URL_RE)?.[0];
}

function lazyFindPrUrl(messages: ChatMessage[]): string | undefined {
  const recent = messages.slice(-20);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.role === 'assistant') {
      const url = extractPrUrl(m.content);
      if (url) return url;
    }
  }
  return undefined;
}

/**
 * Mirrors the pill-type classification in ThreadsView.renderContextFooter.
 */
type PillType = 'url' | 'pr-text' | 'aws' | 'branch';

function classifySegment(segment: string): PillType {
  if (/^https?:\/\//.test(segment)) return 'url';
  if (/^PR #\d+/.test(segment)) return 'pr-text';
  if (/AWS/.test(segment)) return 'aws';
  return 'branch';
}

/**
 * Mirrors the two-or-more-spaces split used to produce footer pills from
 * a statusLineCommand's stdout.
 */
function parseShellPills(text: string): string[] {
  return text.split(/  +/).map(s => s.trim()).filter(Boolean);
}

function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: 'x', role, content, timestamp: 0 };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('extractPrUrl — PR URL detection in message content', () => {
  it('returns the PR URL when present', () => {
    expect(extractPrUrl('PR is up: https://github.com/owner/repo/pull/42'))
      .toBe('https://github.com/owner/repo/pull/42');
  });

  it('returns undefined when no PR URL is present', () => {
    expect(extractPrUrl('No PRs here, just some text')).toBeUndefined();
  });

  it('ignores non-pull GitHub URLs', () => {
    expect(extractPrUrl('See https://github.com/owner/repo/issues/5')).toBeUndefined();
    expect(extractPrUrl('Repo: https://github.com/owner/repo')).toBeUndefined();
  });

  it('stops at whitespace and common delimiters', () => {
    const url = extractPrUrl('PR: https://github.com/owner/repo/pull/99 done');
    expect(url).toBe('https://github.com/owner/repo/pull/99');
  });

  it('stops at closing parenthesis, quote, or angle bracket', () => {
    expect(extractPrUrl('(https://github.com/o/r/pull/1)')).toBe('https://github.com/o/r/pull/1');
    expect(extractPrUrl('"https://github.com/o/r/pull/2"')).toBe('https://github.com/o/r/pull/2');
    expect(extractPrUrl('<https://github.com/o/r/pull/3>')).toBe('https://github.com/o/r/pull/3');
  });

  it('handles multiline message content', () => {
    const content = `Two files changed.\n\nPR: https://github.com/owner/repo/pull/54\n\nLGTM!`;
    expect(extractPrUrl(content)).toBe('https://github.com/owner/repo/pull/54');
  });
});

describe('ThreadManager.onMessage — prUrl stored on thread', () => {
  it('sets prUrl when assistant message contains a GitHub PR URL', () => {
    const thread = { prUrl: undefined } as Partial<Thread>;
    const content = 'PR is up: https://github.com/owner/repo/pull/54';
    const match = content.match(PR_URL_RE);
    if (match) thread.prUrl = match[0];
    expect(thread.prUrl).toBe('https://github.com/owner/repo/pull/54');
  });

  it('updates prUrl to the most recent URL seen (later message overwrites)', () => {
    const thread = { prUrl: undefined } as Partial<Thread>;
    for (const content of [
      'First PR: https://github.com/owner/repo/pull/10',
      'Updated PR: https://github.com/owner/repo/pull/11',
    ]) {
      const match = content.match(PR_URL_RE);
      if (match) thread.prUrl = match[0];
    }
    expect(thread.prUrl).toBe('https://github.com/owner/repo/pull/11');
  });

  it('leaves prUrl unchanged when no PR URL in message', () => {
    const thread = { prUrl: 'https://github.com/owner/repo/pull/7' } as Partial<Thread>;
    const content = 'Here is a summary of changes.';
    const match = content.match(PR_URL_RE);
    if (match) thread.prUrl = match[0];
    expect(thread.prUrl).toBe('https://github.com/owner/repo/pull/7');
  });
});

describe('lazyFindPrUrl — backfill scan for existing threads', () => {
  it('finds a PR URL in the most recent assistant message', () => {
    const msgs: ChatMessage[] = [
      makeMessage('user', 'Create a PR please'),
      makeMessage('assistant', 'Done: https://github.com/a/b/pull/5'),
    ];
    expect(lazyFindPrUrl(msgs)).toBe('https://github.com/a/b/pull/5');
  });

  it('returns the most recent (latest) PR URL when multiple messages have URLs', () => {
    const msgs: ChatMessage[] = [
      makeMessage('assistant', 'Old PR: https://github.com/a/b/pull/1'),
      makeMessage('user', 'ok'),
      makeMessage('assistant', 'New PR: https://github.com/a/b/pull/2'),
    ];
    expect(lazyFindPrUrl(msgs)).toBe('https://github.com/a/b/pull/2');
  });

  it('skips user messages', () => {
    const msgs: ChatMessage[] = [
      makeMessage('user', 'https://github.com/a/b/pull/99 — can you look at this?'),
    ];
    expect(lazyFindPrUrl(msgs)).toBeUndefined();
  });

  it('returns undefined when no assistant message has a PR URL', () => {
    const msgs: ChatMessage[] = [
      makeMessage('assistant', 'No PR here, just text.'),
      makeMessage('user', 'thanks'),
    ];
    expect(lazyFindPrUrl(msgs)).toBeUndefined();
  });

  it('only looks at the last 20 messages', () => {
    const old = makeMessage('assistant', 'https://github.com/a/b/pull/1');
    const filler = Array.from({ length: 20 }, () => makeMessage('user', 'bump'));
    expect(lazyFindPrUrl([old, ...filler])).toBeUndefined();
  });
});

describe('classifySegment — footer pill type heuristics', () => {
  it('classifies http/https URLs as "url"', () => {
    expect(classifySegment('http://localhost:3000')).toBe('url');
    expect(classifySegment('https://example.com')).toBe('url');
  });

  it('classifies "PR #N" text segments as "pr-text"', () => {
    expect(classifySegment('PR #42')).toBe('pr-text');
    expect(classifySegment('PR #1234 (merged)')).toBe('pr-text');
  });

  it('classifies AWS segments', () => {
    expect(classifySegment('AWS ok')).toBe('aws');
    expect(classifySegment('AWS expired')).toBe('aws');
  });

  it('falls back to "branch" for everything else', () => {
    expect(classifySegment('main')).toBe('branch');
    expect(classifySegment('feat/my-feature')).toBe('branch');
    expect(classifySegment('HEAD detached')).toBe('branch');
  });
});

describe('parseShellPills — stdout → pill segments', () => {
  it('splits on two or more spaces', () => {
    expect(parseShellPills('main  https://localhost:3000')).toEqual(['main', 'https://localhost:3000']);
  });

  it('handles three or more spaces', () => {
    expect(parseShellPills('feat/x   PR #5   AWS ok')).toEqual(['feat/x', 'PR #5', 'AWS ok']);
  });

  it('trims leading/trailing whitespace from each segment', () => {
    expect(parseShellPills('  main  ')).toEqual(['main']);
  });

  it('filters out blank segments', () => {
    expect(parseShellPills('')).toEqual([]);
    expect(parseShellPills('   ')).toEqual([]);
  });

  it('treats a single-space gap as part of the segment text', () => {
    // "PR #42" contains a single space — should remain one segment
    expect(parseShellPills('main  PR #42')).toEqual(['main', 'PR #42']);
  });
});

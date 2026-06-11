import { describe, it, expect } from 'vitest';
import { parseStatusLine, derivePrUrl, resolveTagIcon } from '../../src/statusLine';
import type { StatusTag } from '../../src/types';

describe('parseStatusLine — JSON', () => {
  it('parses a JSON array of tags', () => {
    const tags = parseStatusLine('[{"label":"main","kind":"branch"},{"label":"AWS ok","kind":"aws"}]');
    expect(tags).toEqual([
      { label: 'main', kind: 'branch' },
      { label: 'AWS ok', kind: 'aws' },
    ]);
  });

  it('parses the { tags: [...] } object form', () => {
    const tags = parseStatusLine('{"tags":[{"label":"PR #42","url":"https://x/pull/42","kind":"pr"}]}');
    expect(tags).toEqual([{ label: 'PR #42', url: 'https://x/pull/42', kind: 'pr' }]);
  });

  it('keeps only recognized fields and coerces unknown tone away', () => {
    const tags = parseStatusLine('[{"label":"x","url":"u","icon":"globe","tone":"loud","kind":"dev","extra":1}]');
    expect(tags).toEqual([{ label: 'x', url: 'u', icon: 'globe', kind: 'dev' }]);
  });

  it('drops entries with no/blank label', () => {
    const tags = parseStatusLine('[{"label":""},{"nope":1},{"label":"keep"}]');
    expect(tags).toEqual([{ label: 'keep' }]);
  });

  it('falls back to plaintext when JSON is malformed but starts with [', () => {
    // A "[draft]" branch label is not JSON — must not blank the footer.
    const tags = parseStatusLine('[draft] main');
    expect(tags).toEqual([{ label: '[draft] main', icon: 'git-branch', kind: 'branch' }]);
  });

  it('falls back to plaintext when JSON parses but is the wrong shape', () => {
    const tags = parseStatusLine('{"foo":"bar"}');
    // Object without a tags array → treated as one plaintext segment.
    expect(tags).toEqual([{ label: '{"foo":"bar"}', icon: 'git-branch', kind: 'branch' }]);
  });
});

describe('parseStatusLine — plaintext (legacy heuristics)', () => {
  it('returns [] for empty/whitespace output', () => {
    expect(parseStatusLine('')).toEqual([]);
    expect(parseStatusLine('   \n')).toEqual([]);
  });

  it('splits on 2+ spaces into segments', () => {
    const tags = parseStatusLine('http://localhost:3001  main  AWS ok');
    expect(tags.map((t) => t.label)).toEqual(['http://localhost:3001', 'main', 'AWS ok']);
  });

  it('maps a URL segment to a globe dev tag', () => {
    expect(parseStatusLine('https://x.dev')).toEqual([
      { label: 'https://x.dev', url: 'https://x.dev', icon: 'globe', kind: 'dev' },
    ]);
  });

  it('maps a PR #N segment to a pull-request pr tag', () => {
    expect(parseStatusLine('PR #221')).toEqual([
      { label: 'PR #221', icon: 'git-pull-request', kind: 'pr' },
    ]);
  });

  it('maps AWS ok / expired with tone', () => {
    expect(parseStatusLine('AWS ok')).toEqual([{ label: 'AWS ok', icon: 'cloud', tone: 'normal', kind: 'aws' }]);
    expect(parseStatusLine('AWS expired')).toEqual([{ label: 'AWS expired', icon: 'cloud-off', tone: 'warn', kind: 'aws' }]);
  });

  it('maps any other segment to a git-branch tag', () => {
    expect(parseStatusLine('feat/x')).toEqual([{ label: 'feat/x', icon: 'git-branch', kind: 'branch' }]);
  });

  it('preserves the legacy single-segment "branch PR #N" behavior (one space, not split)', () => {
    // The current bash script emits "<branch> PR #N" with a single space.
    const tags = parseStatusLine('feat/x PR #5');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ label: 'feat/x PR #5', icon: 'git-branch', kind: 'branch' });
  });
});

describe('derivePrUrl', () => {
  it('prefers a kind:pr tag with a url', () => {
    const tags: StatusTag[] = [
      { label: 'main', kind: 'branch' },
      { label: 'PR #9', url: 'https://gh/o/r/pull/9', kind: 'pr' },
    ];
    expect(derivePrUrl(tags)).toBe('https://gh/o/r/pull/9');
  });

  it('falls back to any url matching /pull/N', () => {
    const tags: StatusTag[] = [{ label: 'see', url: 'https://gh/o/r/pull/12' }];
    expect(derivePrUrl(tags)).toBe('https://gh/o/r/pull/12');
  });

  it('ignores a pr tag with no url and non-PR urls', () => {
    const tags: StatusTag[] = [
      { label: 'PR pending', kind: 'pr' },
      { label: 'site', url: 'https://example.com' },
    ];
    expect(derivePrUrl(tags)).toBeUndefined();
  });

  it('returns the first PR tag when several exist', () => {
    const tags: StatusTag[] = [
      { label: 'PR #1', url: 'https://gh/pull/1', kind: 'pr' },
      { label: 'PR #2', url: 'https://gh/pull/2', kind: 'pr' },
    ];
    expect(derivePrUrl(tags)).toBe('https://gh/pull/1');
  });

  it('returns undefined for no tags', () => {
    expect(derivePrUrl([])).toBeUndefined();
  });
});

describe('resolveTagIcon', () => {
  it('uses an explicit icon over kind', () => {
    expect(resolveTagIcon({ label: 'x', icon: 'star', kind: 'pr' })).toBe('star');
  });

  it('resolves icon from kind when icon omitted', () => {
    expect(resolveTagIcon({ label: 'x', kind: 'pr' })).toBe('git-pull-request');
    expect(resolveTagIcon({ label: 'x', kind: 'branch' })).toBe('git-branch');
    expect(resolveTagIcon({ label: 'x', kind: 'dev' })).toBe('globe');
    expect(resolveTagIcon({ label: 'x', kind: 'aws' })).toBe('cloud');
    expect(resolveTagIcon({ label: 'x', kind: 'aws', tone: 'warn' })).toBe('cloud-off');
  });

  it('falls back to a generic tag icon for unknown kinds', () => {
    expect(resolveTagIcon({ label: 'x' })).toBe('tag');
    expect(resolveTagIcon({ label: 'x', kind: 'custom' })).toBe('tag');
  });
});

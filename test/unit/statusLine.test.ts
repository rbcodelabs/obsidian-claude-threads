import { describe, it, expect } from 'vitest';
import { parseStatusLine, derivePrUrl, resolveTagIcon, planFooter } from '../../src/statusLine';
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

describe('planFooter — git diff bar dedupe', () => {
  const PR_URL = 'https://github.com/acme/hip-trip/pull/121';

  it('drops the synthesized PR pill while the git diff bar is visible', () => {
    // The exact duplicate that shipped: bar shows "PR #121", footer showed it too.
    const plan = planFooter({ tags: [], prUrl: PR_URL, barShowsGitInfo: true });
    expect(plan.showPrPill).toBe(false);
    expect(plan.empty).toBe(true);
  });

  it('keeps the PR pill once the bar hides (PR merged, back on base branch)', () => {
    const plan = planFooter({ tags: [], prUrl: PR_URL, barShowsGitInfo: false });
    expect(plan.showPrPill).toBe(true);
    expect(plan.empty).toBe(false);
  });

  it('drops script-provided pr and branch tags while the bar is visible', () => {
    const tags: StatusTag[] = [
      { label: 'PR #121', url: PR_URL, kind: 'pr' },
      { label: 'fix/pr-dropdown-border-radius', kind: 'branch' },
      { label: 'http://localhost:3000', url: 'http://localhost:3000', kind: 'dev' },
    ];
    const plan = planFooter({ tags, prUrl: PR_URL, barShowsGitInfo: true });
    expect(plan.tags.map((t) => t.kind)).toEqual(['dev']);
    expect(plan.showPrPill).toBe(false);
  });

  it('keeps non-git tags (dev/preview/aws) untouched — the bar never shows those', () => {
    const tags: StatusTag[] = [
      { label: 'http://localhost:3000', url: 'http://localhost:3000', kind: 'dev' },
      { label: 'Preview', url: 'https://x.vercel.app', kind: 'preview' },
      { label: 'AWS ok', kind: 'aws' },
    ];
    const plan = planFooter({ tags, prUrl: undefined, barShowsGitInfo: true });
    expect(plan.tags).toHaveLength(3);
    expect(plan.empty).toBe(false);
  });

  it('keeps pr and branch tags when the bar is hidden', () => {
    const tags: StatusTag[] = [
      { label: 'PR #121', url: PR_URL, kind: 'pr' },
      { label: 'main', kind: 'branch' },
    ];
    const plan = planFooter({ tags, prUrl: PR_URL, barShowsGitInfo: false });
    expect(plan.tags).toHaveLength(2);
    // A live pr tag already renders, so the synthesized pill must not double it.
    expect(plan.showPrPill).toBe(false);
  });

  it('reports empty when there is nothing to show at all', () => {
    expect(planFooter({ tags: [], prUrl: undefined, barShowsGitInfo: false }).empty).toBe(true);
  });
});

describe('planFooter — stale sticky prUrl from another repo', () => {
  // Observed in real data.json: threads carrying a geode PR while their cwd had
  // been moved to the obsidian-claude-threads worktree. prUrl is sticky across
  // set_working_directory, so it outlived the project it belonged to.
  const GEODE_PR = 'https://github.com/rbcodelabs/geode/pull/121';

  it('hides the sticky PR pill when the PR is provably from another repo', () => {
    const plan = planFooter({
      tags: [],
      prUrl: GEODE_PR,
      barShowsGitInfo: false,
      prRepoMatches: false,
    });
    expect(plan.showPrPill).toBe(false);
    expect(plan.empty).toBe(true);
  });

  it('still shows the pill when the repo matches (after-merge case)', () => {
    const plan = planFooter({
      tags: [],
      prUrl: GEODE_PR,
      barShowsGitInfo: false,
      prRepoMatches: true,
    });
    expect(plan.showPrPill).toBe(true);
  });

  it('defaults to showing the pill when repo match is not supplied', () => {
    expect(planFooter({ tags: [], prUrl: GEODE_PR, barShowsGitInfo: false }).showPrPill).toBe(true);
  });
});

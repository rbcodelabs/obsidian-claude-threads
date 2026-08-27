import { describe, it, expect } from 'vitest';
import {
  parseShortStat,
  parseRemoteToOwnerRepo,
  buildComparePrUrl,
  gitDiffBarVisible,
  parsePrNumber,
  prButtonLabel,
} from '../../src/gitDiffUtils';

describe('parseShortStat', () => {
  it('parses a full "files changed, insertions, deletions" line', () => {
    expect(parseShortStat(' 3 files changed, 60 insertions(+), 4 deletions(-)')).toEqual({
      insertions: 60,
      deletions: 4,
    });
  });

  it('parses singular "1 insertion(+)" with no deletions segment', () => {
    expect(parseShortStat(' 1 file changed, 1 insertion(+)')).toEqual({ insertions: 1, deletions: 0 });
  });

  it('parses a deletions-only line with no insertions segment', () => {
    expect(parseShortStat(' 1 file changed, 3 deletions(-)')).toEqual({ insertions: 0, deletions: 3 });
  });

  it('parses singular "1 deletion(-)"', () => {
    expect(parseShortStat(' 1 file changed, 1 deletion(-)')).toEqual({ insertions: 0, deletions: 1 });
  });

  it('returns zeros for empty output (no changes)', () => {
    expect(parseShortStat('')).toEqual({ insertions: 0, deletions: 0 });
  });

  it('returns zeros for output with no insertions/deletions segments', () => {
    expect(parseShortStat(' 0 files changed')).toEqual({ insertions: 0, deletions: 0 });
  });

  it('handles large counts', () => {
    expect(parseShortStat(' 42 files changed, 1234 insertions(+), 5678 deletions(-)')).toEqual({
      insertions: 1234,
      deletions: 5678,
    });
  });
});

describe('parseRemoteToOwnerRepo', () => {
  it('parses an ssh-shorthand GitHub remote', () => {
    expect(parseRemoteToOwnerRepo('git@github.com:acme/hip-trip.git')).toEqual({ owner: 'acme', repo: 'hip-trip' });
  });

  it('parses an ssh-shorthand GitHub remote without .git', () => {
    expect(parseRemoteToOwnerRepo('git@github.com:acme/hip-trip')).toEqual({ owner: 'acme', repo: 'hip-trip' });
  });

  it('parses an ssh:// GitHub remote', () => {
    expect(parseRemoteToOwnerRepo('ssh://git@github.com/acme/hip-trip.git')).toEqual({
      owner: 'acme',
      repo: 'hip-trip',
    });
  });

  it('parses an https GitHub remote with .git suffix', () => {
    expect(parseRemoteToOwnerRepo('https://github.com/acme/hip-trip.git')).toEqual({
      owner: 'acme',
      repo: 'hip-trip',
    });
  });

  it('parses an https GitHub remote without .git suffix', () => {
    expect(parseRemoteToOwnerRepo('https://github.com/acme/hip-trip')).toEqual({ owner: 'acme', repo: 'hip-trip' });
  });

  it('parses an https GitHub remote with a trailing slash', () => {
    expect(parseRemoteToOwnerRepo('https://github.com/acme/hip-trip/')).toEqual({ owner: 'acme', repo: 'hip-trip' });
  });

  it('parses an https GitHub remote with an embedded user@ segment', () => {
    expect(parseRemoteToOwnerRepo('https://user@github.com/acme/hip-trip.git')).toEqual({
      owner: 'acme',
      repo: 'hip-trip',
    });
  });

  it('returns null for a non-GitHub remote', () => {
    expect(parseRemoteToOwnerRepo('https://gitlab.com/acme/hip-trip.git')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseRemoteToOwnerRepo('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseRemoteToOwnerRepo('not a url at all')).toBeNull();
  });
});

describe('buildComparePrUrl', () => {
  it('builds a GitHub compare URL', () => {
    expect(buildComparePrUrl('acme', 'hip-trip', 'main', 'feat/offer-click-override')).toBe(
      'https://github.com/acme/hip-trip/compare/main...feat%2Foffer-click-override?expand=1',
    );
  });
});

describe('gitDiffBarVisible', () => {
  it('is visible for a feature branch in a git repo', () => {
    expect(gitDiffBarVisible({ isGitRepo: true, branch: 'fix/thing', isBaseBranch: false })).toBe(true);
  });

  it('is hidden when the cwd is not a git repo', () => {
    expect(gitDiffBarVisible({ isGitRepo: false, branch: 'fix/thing' })).toBe(false);
  });

  it('is hidden on the base branch (nothing to open a PR against)', () => {
    expect(gitDiffBarVisible({ isGitRepo: true, branch: 'main', isBaseBranch: true })).toBe(false);
  });

  it('is hidden with no resolvable branch (detached HEAD)', () => {
    expect(gitDiffBarVisible({ isGitRepo: true, branch: undefined })).toBe(false);
  });

  it('is hidden when git info has not been populated yet', () => {
    expect(gitDiffBarVisible(undefined)).toBe(false);
    expect(gitDiffBarVisible(null)).toBe(false);
  });
});

describe('parsePrNumber', () => {
  it('extracts the number from a GitHub PR url', () => {
    expect(parsePrNumber('https://github.com/acme/hip-trip/pull/121')).toBe(121);
  });

  it('extracts the number when the url has a trailing path segment', () => {
    expect(parsePrNumber('https://github.com/acme/hip-trip/pull/7/files')).toBe(7);
  });

  it('returns null for a url with no /pull/N segment', () => {
    expect(parsePrNumber('https://github.com/acme/hip-trip')).toBeNull();
  });

  it('returns null for empty/undefined input', () => {
    expect(parsePrNumber('')).toBeNull();
    expect(parsePrNumber(undefined)).toBeNull();
  });
});

describe('prButtonLabel', () => {
  it('says "Create PR" when the thread has no PR yet', () => {
    expect(prButtonLabel(undefined)).toBe('Create PR');
  });

  it('carries the PR number so the footer does not need its own pill', () => {
    expect(prButtonLabel('https://github.com/acme/hip-trip/pull/121')).toBe('PR #121');
  });

  it('falls back to "View PR" for a PR url with no parseable number', () => {
    expect(prButtonLabel('https://github.com/acme/hip-trip/pulls')).toBe('View PR');
  });
});

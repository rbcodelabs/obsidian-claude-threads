import { describe, it, expect } from 'vitest';
import { parseShortStat, parseRemoteToOwnerRepo, buildComparePrUrl } from '../../src/gitDiffUtils';

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

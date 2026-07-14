/**
 * Pure parsing/derivation logic for the git diff bar (branch + PR create button
 * shown above the compose box for git-connected working directories). No
 * Obsidian or Node dependencies so it is trivially unit-testable — mirrors the
 * split in src/statusLine.ts (pure parsing) vs src/StatusLineService.ts
 * (process orchestration).
 */

/** Parsed insertion/deletion counts from `git diff --shortstat` output. */
export interface ShortStat {
  insertions: number;
  deletions: number;
}

/**
 * Parses `git diff --shortstat` output, e.g.:
 *   " 3 files changed, 60 insertions(+), 4 deletions(-)"
 *   " 1 file changed, 1 insertion(+)"
 *   " 1 file changed, 3 deletions(-)"
 *   "" (no changes)
 * Missing insertions/deletions segments (singular or absent entirely) resolve to 0.
 */
export function parseShortStat(text: string): ShortStat {
  const insertMatch = text.match(/(\d+) insertions?\(\+\)/);
  const deleteMatch = text.match(/(\d+) deletions?\(-\)/);
  return {
    insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
  };
}

/** An owner/repo pair parsed from a git remote URL. */
export interface OwnerRepo {
  owner: string;
  repo: string;
}

/**
 * Parses a `git remote get-url origin` value into a GitHub owner/repo pair.
 * Supports:
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 *   - https://github.com/owner/repo.git (with or without trailing .git / slash,
 *     with or without a leading user@ segment)
 * Returns null for anything else (non-GitHub remotes, malformed URLs, empty input).
 */
export function parseRemoteToOwnerRepo(url: string): OwnerRepo | null {
  if (!url) return null;
  const trimmed = url.trim();

  let m = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };

  m = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };

  m = trimmed.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };

  return null;
}

/**
 * Builds a GitHub "compare" URL for manually opening a PR creation page —
 * used by the "Manually create PR" dropdown action.
 */
export function buildComparePrUrl(owner: string, repo: string, base: string, branch: string): string {
  return `https://github.com/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}

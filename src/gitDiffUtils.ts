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

/** Minimal shape of GitDiffInfo needed to decide bar visibility (structural, so
 *  this module stays free of a types.ts import cycle). */
export interface GitDiffBarState {
  isGitRepo: boolean;
  branch?: string;
  isBaseBranch?: boolean;
}

/**
 * Whether the git diff bar renders for this thread. Single source of truth,
 * shared by `renderGitDiffBar` (what to draw) and `renderStatusFooter` (whether
 * a footer pill would be a duplicate of what the bar already shows).
 *
 * Hidden when there's no git info yet, the cwd isn't a repo, the branch can't be
 * resolved (detached HEAD), or we're sitting on the base branch — the last case
 * matters for dedupe: after a PR merges and the thread returns to `main`, the
 * bar disappears and the footer PR pill becomes the ONLY surface for that PR.
 */
export function gitDiffBarVisible<T extends GitDiffBarState>(
  gitDiff: T | undefined | null,
): gitDiff is T {
  if (!gitDiff) return false;
  return !!gitDiff.isGitRepo && !gitDiff.isBaseBranch && !!gitDiff.branch;
}

/** Extracts the numeric PR id from a GitHub pull-request URL, else null. */
export function parsePrNumber(prUrl: string | undefined | null): number | null {
  if (!prUrl) return null;
  const m = prUrl.match(/\/pull\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Label for the git diff bar's primary action button.
 *
 * With a PR url we surface its number ("PR #121") rather than a generic
 * "View PR", so the bar carries the PR's identity itself and the context footer
 * no longer needs a separate pill to say which PR this thread belongs to.
 */
export function prButtonLabel(prUrl: string | undefined | null): string {
  if (!prUrl) return 'Create PR';
  const n = parsePrNumber(prUrl);
  return n === null ? 'View PR' : `PR #${n}`;
}

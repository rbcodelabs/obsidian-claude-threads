import path from 'path';
import os from 'os';

/**
 * Where `enter_worktree` puts the worktrees it creates.
 *
 * ## Why not os.tmpdir()
 *
 * Worktrees used to be created under `<os.tmpdir()>/claude-worktrees/<uuid8>`.
 * On macOS `os.tmpdir()` is the per-user `$TMPDIR` (`/var/folders/<hash>/T/`),
 * which the OS clears on reboot. That made every worktree volatile: a restart
 * silently deleted the directory and any uncommitted work inside it, with no
 * warning and no recovery window. This is not a slow "stale temp file" reaper
 * with a grace period — the next reboot takes everything.
 *
 * The default is now a durable, app-owned location that survives restarts.
 *
 * ## Why not `.claude/worktrees`
 *
 * The plugin is harness-neutral: `enter_worktree` is a plugin tool that a Codex
 * session calls exactly as a Claude session does (see `agentHarness`). Naming
 * the directory after one harness would be wrong for the other. Genuinely
 * Claude-owned paths (`~/.claude/skills`, `~/.claude/agents`) keep that prefix;
 * worktrees do not.
 */

/** Directory name used by the legacy `os.tmpdir()` layout. Still recognised for repair/migration. */
export const LEGACY_WORKTREE_DIR_NAME = 'claude-worktrees';

/**
 * Default durable root: `~/.geode/worktrees`.
 *
 * Named after the app rather than the harness, and deliberately outside every
 * repo so no `.gitignore` entry is needed and `git status` stays clean.
 */
export function defaultWorktreeRoot(): string {
  return path.join(os.homedir(), '.geode', 'worktrees');
}

/** The legacy `<os.tmpdir()>/claude-worktrees` container. */
export function legacyWorktreeRoot(): string {
  return path.join(os.tmpdir(), LEGACY_WORKTREE_DIR_NAME);
}

/**
 * Resolves the configured worktree root, falling back to {@link defaultWorktreeRoot}.
 *
 * A blank/whitespace-only setting means "use the default". `~` is expanded so
 * the setting can be written the way a user would type it.
 */
export function resolveWorktreeRoot(configured?: string | null): string {
  const raw = configured?.trim();
  if (!raw) return defaultWorktreeRoot();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

/**
 * Turns a branch name into a filesystem-safe relative path.
 *
 * Slashes are preserved as directory separators so `fix/foo` nests the way it
 * reads. Path traversal (`..`), absolute-path escapes, and empty segments are
 * stripped so a hostile or malformed branch name cannot write outside the root.
 */
export function sanitizeBranchForPath(branch: string): string {
  const segments = branch
    .split('/')
    .map((s) => s.replace(/[\0<>:"\\|?*]/g, '-').trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  return segments.join(path.sep) || 'worktree';
}

/**
 * Full path for a new worktree: `<root>/<repoName>/<branch>`.
 *
 * Grouping by repo keeps the root browsable when several projects are in play,
 * and makes the branch name visible in the path — unlike the old opaque
 * `<uuid8>` directories, which gave no clue what work was inside.
 */
export function worktreePathFor(root: string, gitRoot: string, branch: string): string {
  return path.join(root, path.basename(gitRoot), sanitizeBranchForPath(branch));
}

/**
 * True when `p` sits inside `container`.
 *
 * Compares with a trailing separator so `/a/bc` is not treated as living inside
 * `/a/b`, and treats the container itself as outside (callers repair paths
 * *within* a container, never the container itself).
 */
export function isInsideDir(p: string, container: string): boolean {
  const rel = path.relative(container, p);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True when `p` looks like a worktree this plugin created — under either the
 * current root or the legacy `os.tmpdir()` container.
 *
 * Both are checked because threads persisted before this change still carry
 * `cwd` values pointing at the old tmpdir layout, and those paths must stay
 * repairable (see `ThreadManager.repairStaleCwds`).
 */
export function isManagedWorktreePath(
  p: string,
  opts: { root?: string | null; realRoots?: string[] } = {},
): boolean {
  const containers = [
    resolveWorktreeRoot(opts.root),
    legacyWorktreeRoot(),
    ...(opts.realRoots ?? []),
  ];
  return containers.some((c) => isInsideDir(p, c));
}

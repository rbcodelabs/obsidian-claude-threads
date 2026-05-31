/**
 * Resolves a human-readable project name from a working directory path.
 *
 * Handles two cases:
 * - Worktree paths: `/.../<project>/.worktrees/<branch>` → returns `<project>`
 * - Normal paths: `/.../<project>` → returns last path component
 */
export function resolveProjectName(cwd: string): string {
  if (!cwd) return '';

  const worktreeMarker = '/.worktrees/';
  const worktreeIndex = cwd.indexOf(worktreeMarker);
  if (worktreeIndex !== -1) {
    const beforeWorktrees = cwd.slice(0, worktreeIndex);
    const lastSlash = beforeWorktrees.lastIndexOf('/');
    return lastSlash === -1 ? beforeWorktrees : beforeWorktrees.slice(lastSlash + 1);
  }

  const lastSlash = cwd.lastIndexOf('/');
  return lastSlash === -1 ? cwd : cwd.slice(lastSlash + 1);
}

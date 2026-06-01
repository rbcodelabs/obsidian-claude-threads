/**
 * Resolves a human-readable project name (git repo name) from a working directory path.
 *
 * Strategy (in order):
 * 1. Walk up from `cwd` looking for a `.git` entry.
 *    - `.git` is a *directory*  → we found the main repo root; return its basename.
 *    - `.git` is a *file*       → we're in a worktree; parse the `gitdir:` pointer,
 *                                  navigate to the main `.git` dir, and return the
 *                                  repo root's basename.
 * 2. If nothing is found, return the last path component as a fallback.
 *
 * Uses synchronous fs calls (acceptable — only called from UI render paths on desktop).
 */
export function resolveProjectName(cwd: string): string {
  if (!cwd) return '';

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');

    // Walk up the directory tree (cap at 10 levels to avoid runaway loops)
    let dir = cwd;
    for (let i = 0; i < 10; i++) {
      const gitEntry = nodePath.join(dir, '.git');

      if (fs.existsSync(gitEntry)) {
        const stat = fs.statSync(gitEntry);

        if (stat.isDirectory()) {
          // Standard repo root — the parent of .git is the project.
          return nodePath.basename(dir);
        }

        if (stat.isFile()) {
          // Worktree: .git is a file like "gitdir: /path/to/main/.git/worktrees/branch"
          const content = fs.readFileSync(gitEntry, 'utf8').trim();
          const match = content.match(/^gitdir:\s*(.+)$/m);
          if (match) {
            const gitdirPath = nodePath.resolve(dir, match[1].trim());
            // gitdirPath is something like /repo/.git/worktrees/<name>
            // Navigate: strip /worktrees/<name> to reach /repo/.git, then go up one more
            const worktreesSep = nodePath.sep + 'worktrees' + nodePath.sep;
            const idx = gitdirPath.indexOf(worktreesSep);
            if (idx !== -1) {
              const mainGitDir = gitdirPath.slice(0, idx);       // /repo/.git
              const repoRoot   = nodePath.dirname(mainGitDir);   // /repo
              return nodePath.basename(repoRoot);
            }
            // Fallback: just use the parent of the gitdir we found
            return nodePath.basename(nodePath.dirname(nodePath.dirname(gitdirPath)));
          }
        }
      }

      const parent = nodePath.dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  } catch {
    // Silently fall through to basename fallback on any I/O error
  }

  // Last resort: return the final path component, but suppress it when it looks
  // like a raw worktree hash inside a claude-worktrees tmp directory (those are
  // meaningless without a .git file to trace back to the real repo).
  const lastSlash = cwd.lastIndexOf('/');
  const basename = lastSlash === -1 ? cwd : cwd.slice(lastSlash + 1);
  const looksLikeWorktreeHash = /claude-worktrees/.test(cwd) && /^[0-9a-f]{6,}$/i.test(basename);
  return looksLikeWorktreeHash ? '' : basename;
}

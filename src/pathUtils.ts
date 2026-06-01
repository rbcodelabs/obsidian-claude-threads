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
    const nodePath = require('path') as typeof import('path');

    // Fast-path string detection: if the path contains /.worktrees/, the segment
    // immediately before it is the repo/project name. This handles the common
    // Claude worktree layout without needing any filesystem I/O.
    const worktreesIdx = cwd.indexOf('/.worktrees/');
    if (worktreesIdx !== -1) {
      const before = cwd.slice(0, worktreesIdx);
      const lastSlashBefore = before.lastIndexOf('/');
      return lastSlashBefore === -1 ? before : before.slice(lastSlashBefore + 1);
    }

    // For absolute paths only: walk up the directory tree looking for a .git
    // entry to determine the real repo root. Skipping relative paths avoids
    // accidentally hitting the test runner's own CWD .git entry.
    if (nodePath.isAbsolute(cwd)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');

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
    }
  } catch {
    // Silently fall through to basename fallback on any I/O error
  }

  // Last resort: return the final path component.
  const lastSlash = cwd.lastIndexOf('/');
  return lastSlash === -1 ? cwd : cwd.slice(lastSlash + 1);
}

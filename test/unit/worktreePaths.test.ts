/**
 * Tests for worktreePaths — the durable worktree location logic.
 *
 * Regression context: worktrees were created under `<os.tmpdir()>/claude-worktrees/`.
 * macOS clears $TMPDIR on reboot, so a restart silently deleted the worktree and any
 * uncommitted work inside it. These tests pin the two properties that prevent a
 * recurrence: the default root is durable (never inside os.tmpdir()), and the legacy
 * layout is still recognised so pre-existing threads stay repairable.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import {
  defaultWorktreeRoot,
  legacyWorktreeRoot,
  resolveWorktreeRoot,
  sanitizeBranchForPath,
  worktreePathFor,
  isInsideDir,
  isManagedWorktreePath,
  LEGACY_WORKTREE_DIR_NAME,
} from '../../src/worktreePaths';

describe('worktreePaths — durability', () => {
  it('default root is NOT inside os.tmpdir() (the reboot-wipe bug)', () => {
    const root = defaultWorktreeRoot();
    expect(isInsideDir(root, os.tmpdir())).toBe(false);
    expect(root.startsWith(os.tmpdir())).toBe(false);
  });

  it('default root lives under the home directory, named for the app not the harness', () => {
    const root = defaultWorktreeRoot();
    expect(root).toBe(path.join(os.homedir(), '.geode', 'worktrees'));
    // Harness-neutral: enter_worktree is called by Codex sessions too.
    expect(root).not.toContain('.claude');
  });

  it('legacy root still points at the old tmpdir layout', () => {
    expect(legacyWorktreeRoot()).toBe(path.join(os.tmpdir(), LEGACY_WORKTREE_DIR_NAME));
  });
});

describe('worktreePaths — resolveWorktreeRoot', () => {
  it('falls back to the default when unset, blank, or whitespace', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(resolveWorktreeRoot(v)).toBe(defaultWorktreeRoot());
    }
  });

  it('expands a leading ~', () => {
    expect(resolveWorktreeRoot('~/wt')).toBe(path.join(os.homedir(), 'wt'));
    expect(resolveWorktreeRoot('~')).toBe(os.homedir());
  });

  it('does not expand ~ mid-path or in a bare name', () => {
    expect(resolveWorktreeRoot('/a/~/b')).toBe(path.resolve('/a/~/b'));
    expect(resolveWorktreeRoot('~foo')).toBe(path.resolve('~foo'));
  });

  it('honours an explicit absolute override', () => {
    expect(resolveWorktreeRoot('/srv/worktrees')).toBe(path.resolve('/srv/worktrees'));
  });
});

describe('worktreePaths — sanitizeBranchForPath', () => {
  it('keeps slashes as nested directories', () => {
    expect(sanitizeBranchForPath('fix/worktree-durability'))
      .toBe(path.join('fix', 'worktree-durability'));
  });

  it('strips traversal segments so a branch cannot escape the root', () => {
    expect(sanitizeBranchForPath('../../etc/passwd')).toBe(path.join('etc', 'passwd'));
    expect(sanitizeBranchForPath('a/../../b')).toBe(path.join('a', 'b'));
    expect(sanitizeBranchForPath('./x')).toBe('x');
  });

  it('drops empty segments from leading, trailing, and doubled slashes', () => {
    expect(sanitizeBranchForPath('/a//b/')).toBe(path.join('a', 'b'));
  });

  it('never returns an empty path', () => {
    expect(sanitizeBranchForPath('..')).toBe('worktree');
    expect(sanitizeBranchForPath('///')).toBe('worktree');
  });

  it('replaces characters that are illegal in path segments', () => {
    expect(sanitizeBranchForPath('feat/a:b*c?')).toBe(path.join('feat', 'a-b-c-'));
  });
});

describe('worktreePaths — worktreePathFor', () => {
  it('groups by repo name and branch, so the path says what is inside', () => {
    const p = worktreePathFor('/roots', '/home/me/projects/my-repo', 'fix/thing');
    expect(p).toBe(path.join('/roots', 'my-repo', 'fix', 'thing'));
  });

  it('a traversal branch still lands inside the root', () => {
    const root = '/roots';
    const p = worktreePathFor(root, '/repo', '../../../etc');
    expect(isInsideDir(p, root)).toBe(true);
  });
});

describe('worktreePaths — isInsideDir', () => {
  it('detects containment', () => {
    expect(isInsideDir('/a/b/c', '/a')).toBe(true);
  });

  it('a directory is not inside itself', () => {
    expect(isInsideDir('/a', '/a')).toBe(false);
  });

  it('does not treat a sibling with a shared prefix as contained', () => {
    // Guards the classic `startsWith` bug: /a/bc is not inside /a/b.
    expect(isInsideDir('/a/bc', '/a/b')).toBe(false);
  });

  it('rejects paths outside the container', () => {
    expect(isInsideDir('/x/y', '/a')).toBe(false);
  });
});

describe('worktreePaths — isManagedWorktreePath', () => {
  it('recognises paths under the current default root', () => {
    expect(isManagedWorktreePath(path.join(defaultWorktreeRoot(), 'repo', 'br'))).toBe(true);
  });

  it('still recognises legacy tmpdir paths, so old threads stay repairable', () => {
    expect(isManagedWorktreePath(path.join(legacyWorktreeRoot(), 'deadbeef'))).toBe(true);
  });

  it('recognises paths under a configured override root', () => {
    expect(isManagedWorktreePath('/custom/wt/repo/br', { root: '/custom/wt' })).toBe(true);
  });

  it('ignores unrelated paths', () => {
    expect(isManagedWorktreePath('/home/me/projects/repo')).toBe(false);
  });

  it('ignores the container itself', () => {
    expect(isManagedWorktreePath(defaultWorktreeRoot())).toBe(false);
    expect(isManagedWorktreePath(legacyWorktreeRoot())).toBe(false);
  });
});

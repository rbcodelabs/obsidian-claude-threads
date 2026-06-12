import { describe, it, expect } from 'vitest';
import type { Thread } from '../../src/types';

/**
 * Mirrors the folder-grouping logic from KanbanView.groupLabel() and the lane
 * sort in KanbanView.renderFolderBoard().
 *
 * The real view reaches into `this.manager.getProject()` and `buildCwdLabel()`
 * (which performs filesystem/git resolution). Here we inject a project-name
 * lookup and a cwd-label resolver so the pure grouping algorithm can be tested
 * deterministically without Obsidian or the filesystem.
 *
 * If the implementation changes, update the functions below to match.
 */
const UNASSIGNED_GROUP = 'Unassigned';

function groupLabel(
  thread: Thread,
  getProjectName: (id: string) => string | undefined,
  cwdLabel: (cwd: string) => string,
): string {
  if (thread.projectId) {
    const name = getProjectName(thread.projectId);
    if (name) return name;
  }
  if (thread.cwd) {
    const label = cwdLabel(thread.cwd);
    if (label) return label;
  }
  return UNASSIGNED_GROUP;
}

function groupThreadsIntoLanes(
  threads: Thread[],
  getProjectName: (id: string) => string | undefined,
  cwdLabel: (cwd: string) => string,
): Array<[string, Thread[]]> {
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const key = groupLabel(t, getProjectName, cwdLabel);
    const bucket = groups.get(key);
    if (bucket) bucket.push(t);
    else groups.set(key, [t]);
  }

  return Array.from(groups.entries()).sort((a, b) => {
    if (a[0] === UNASSIGNED_GROUP) return 1;
    if (b[0] === UNASSIGNED_GROUP) return -1;
    const aRecent = Math.max(...a[1].map(t => t.updatedAt));
    const bRecent = Math.max(...b[1].map(t => t.updatedAt));
    return bRecent - aRecent;
  });
}

function makeThread(
  id: string,
  updatedAt: number,
  overrides: Partial<Thread> = {},
): Thread {
  return {
    id,
    title: id,
    cwd: '/tmp',
    messages: [],
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  } as Thread;
}

// Default resolvers used by most tests.
const projectNames: Record<string, string> = { p1: 'Acme App', p2: 'Side Project' };
const getProjectName = (id: string) => projectNames[id];
// Deterministic stand-in for the real resolveProjectName (git repo name): last
// path segment. The real resolver collapses worktrees to the repo name — see the
// dedicated "worktree collapsing" block below for that behavior.
const cwdLabel = (cwd: string) => cwd.replace(/\/$/, '').split('/').pop() ?? '';

// ── groupLabel resolution precedence ──────────────────────────────────────────

describe('KanbanView folder grouping — group label resolution', () => {
  it('uses the assigned Project name when projectId resolves', () => {
    const t = makeThread('t1', 1_000, { projectId: 'p1', cwd: '/repos/whatever' });
    expect(groupLabel(t, getProjectName, cwdLabel)).toBe('Acme App');
  });

  it('falls back to the cwd label when projectId is unset', () => {
    const t = makeThread('t2', 1_000, { cwd: '/Users/me/projects/obsidian-claude-threads' });
    expect(groupLabel(t, getProjectName, cwdLabel)).toBe('obsidian-claude-threads');
  });

  it('falls back to the cwd label when projectId does not resolve to a project', () => {
    const t = makeThread('t3', 1_000, { projectId: 'ghost', cwd: '/repos/orphaned' });
    expect(groupLabel(t, getProjectName, cwdLabel)).toBe('orphaned');
  });

  it('falls back to Unassigned when there is no project and no cwd', () => {
    const t = makeThread('t4', 1_000, { cwd: '' });
    expect(groupLabel(t, getProjectName, cwdLabel)).toBe(UNASSIGNED_GROUP);
  });

  it('falls back to Unassigned when cwd label resolves to empty string', () => {
    const t = makeThread('t5', 1_000, { cwd: '/' });
    expect(groupLabel(t, getProjectName, () => '')).toBe(UNASSIGNED_GROUP);
  });
});

// ── lane grouping and ordering ────────────────────────────────────────────────

describe('KanbanView folder grouping — lanes', () => {
  it('threads sharing a project collapse into one lane', () => {
    const a = makeThread('a', 1_000, { projectId: 'p1' });
    const b = makeThread('b', 2_000, { projectId: 'p1' });
    const lanes = groupThreadsIntoLanes([a, b], getProjectName, cwdLabel);
    expect(lanes).toHaveLength(1);
    expect(lanes[0][0]).toBe('Acme App');
    expect(lanes[0][1].map(t => t.id)).toEqual(['a', 'b']);
  });

  it('lanes are ordered by most-recent thread activity, descending', () => {
    const acmeOld = makeThread('acmeOld', 1_000, { projectId: 'p1' });
    const sideNew = makeThread('sideNew', 9_000, { projectId: 'p2' });
    const lanes = groupThreadsIntoLanes([acmeOld, sideNew], getProjectName, cwdLabel);
    expect(lanes.map(l => l[0])).toEqual(['Side Project', 'Acme App']);
  });

  it('a lane recency uses its single most-recent thread, not the average', () => {
    // Acme has one very recent thread; Side has two middling ones.
    const acmeOld = makeThread('acmeOld', 1_000, { projectId: 'p1' });
    const acmeNew = makeThread('acmeNew', 10_000, { projectId: 'p1' });
    const sideA = makeThread('sideA', 5_000, { projectId: 'p2' });
    const sideB = makeThread('sideB', 6_000, { projectId: 'p2' });
    const lanes = groupThreadsIntoLanes([acmeOld, sideA, sideB, acmeNew], getProjectName, cwdLabel);
    expect(lanes.map(l => l[0])).toEqual(['Acme App', 'Side Project']);
  });

  it('the Unassigned lane always sorts last regardless of recency', () => {
    const unassignedFresh = makeThread('u', 99_000, { cwd: '' });
    const acme = makeThread('a', 1_000, { projectId: 'p1' });
    const lanes = groupThreadsIntoLanes([unassignedFresh, acme], getProjectName, cwdLabel);
    expect(lanes.map(l => l[0])).toEqual(['Acme App', UNASSIGNED_GROUP]);
  });

  it('every thread lands in exactly one lane and none are dropped', () => {
    const threads = [
      makeThread('a', 1_000, { projectId: 'p1' }),
      makeThread('b', 2_000, { projectId: 'p2' }),
      makeThread('c', 3_000, { cwd: '/repos/loose' }),
      makeThread('d', 4_000, { cwd: '' }),
    ];
    const lanes = groupThreadsIntoLanes(threads, getProjectName, cwdLabel);
    const total = lanes.reduce((n, l) => n + l[1].length, 0);
    expect(total).toBe(4);
    expect(lanes).toHaveLength(4);
  });

  it('empty input produces no lanes', () => {
    expect(groupThreadsIntoLanes([], getProjectName, cwdLabel)).toEqual([]);
  });
});

// ── worktree collapsing (group by repo name, not project · branch) ────────────
// The real KanbanView.groupLabel resolves a cwd to its git REPO name via
// resolveProjectName, so a main checkout and all of its worktrees (feature
// worktrees under .claude/worktrees/, temp worktrees under claude-worktrees/)
// collapse into one lane instead of separate "repo · branch" lanes.

describe('KanbanView folder grouping — worktree collapsing', () => {
  // resolver that mimics resolveProjectName: every worktree of a repo → repo name.
  const repoName = (cwd: string): string => {
    if (cwd.includes('hip-trip-marketing-site')) return 'hip-trip-marketing-site';
    if (cwd.includes('claude-worktrees/')) return 'hip-trip-marketing-site'; // temp worktree of same repo
    return cwd.replace(/\/$/, '').split('/').pop() ?? '';
  };

  it('a main checkout and its feature/temp worktrees collapse into one lane', () => {
    const main = makeThread('main', 1_000, { cwd: '/Users/me/projects/hip-trip-marketing-site' });
    const feat = makeThread('feat', 2_000, { cwd: '/Users/me/projects/hip-trip-marketing-site/.claude/worktrees/feat-ugc-ads' });
    const temp = makeThread('temp', 3_000, { cwd: '/var/folders/x/T/claude-worktrees/b278f8ba' });

    const lanes = groupThreadsIntoLanes([main, feat, temp], getProjectName, repoName);
    expect(lanes).toHaveLength(1);
    expect(lanes[0][0]).toBe('hip-trip-marketing-site');
    expect(lanes[0][1].map(t => t.id).sort()).toEqual(['feat', 'main', 'temp']);
  });

  it('different repos stay in separate lanes', () => {
    const a = makeThread('a', 2_000, { cwd: '/Users/me/projects/hip-trip-marketing-site/.claude/worktrees/x' });
    const b = makeThread('b', 1_000, { cwd: '/Users/me/projects/other-repo' });
    const lanes = groupThreadsIntoLanes([a, b], getProjectName, repoName);
    expect(lanes.map(l => l[0])).toEqual(['hip-trip-marketing-site', 'other-repo']);
  });
});

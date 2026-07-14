import { describe, it, expect } from 'vitest';
import { GitDiffService, type GitDiffExecFile } from '../../src/GitDiffService';
import type { ThreadManager } from '../../src/ThreadManager';
import type { Thread, GitDiffInfo } from '../../src/types';

// ── Fake ThreadManager (only the surface GitDiffService touches) ────────────

function makeThread(id: string, cwd: string): Thread {
  return { id, title: id, cwd, messages: [], createdAt: 0, updatedAt: 0 } as Thread;
}

function fakeManager(threads: Thread[]) {
  const listeners = new Set<(id: string, ev: { type: string }) => void>();
  const applied: Array<{ id: string; info: GitDiffInfo }> = [];
  const mgr = {
    subscribe(l: (id: string, ev: { type: string }) => void) { listeners.add(l); return () => listeners.delete(l); },
    emit(id: string, ev: { type: string }) { for (const l of listeners) l(id, ev); },
    getThreads() { return threads; },
    getThread(id: string) { return threads.find((t) => t.id === id); },
    applyGitDiff(id: string, info: GitDiffInfo) { applied.push({ id, info }); },
    _applied: applied,
    _listenerCount: () => listeners.size,
  };
  return mgr;
}

/**
 * Fake execFile router: keyed by the joined `git <args>` string, mapping to
 * either canned stdout (success) or `null` (simulated non-zero exit). Falls
 * back to a per-cwd table when provided, else a shared table. Any key not
 * found in the table resolves as a non-zero exit (matches how a real `git`
 * subcommand behaves for e.g. `symbolic-ref` on a repo with no such ref).
 */
type GitResponses = Record<string, string | null>;

function makeExecFile(responses: GitResponses, perCwd?: Record<string, GitResponses>) {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const state = { calls, active: 0, maxActive: 0 };
  const execFile: GitDiffExecFile = (_file, args, execOpts, cb) => {
    calls.push({ cwd: execOpts.cwd, args: [...args] });
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const table = perCwd?.[execOpts.cwd] ?? responses;
    const key = args.join(' ');
    const result = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
    setTimeout(() => {
      state.active--;
      if (result === null) cb(new Error('git failed'), '', '');
      else cb(null, result, '');
    }, 0);
  };
  return { execFile, state };
}

const baseDeps = (execFile: GitDiffExecFile, over: Partial<{ now: () => number; isMobile: boolean }> = {}) => ({
  execFile,
  now: () => 1000,
  isMobile: false,
  ...over,
});

// A full "success" response table: a feature branch with a resolvable origin/main
// base, a real diff, and a GitHub origin remote.
const SUCCESS_RESPONSES: GitResponses = {
  'rev-parse --is-inside-work-tree': 'true',
  'rev-parse --abbrev-ref HEAD': 'feat/offer-click-override',
  'symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
  'merge-base HEAD origin/main': 'abc123',
  'diff --shortstat abc123': ' 3 files changed, 60 insertions(+), 4 deletions(-)',
  'remote get-url origin': 'https://github.com/acme/hip-trip.git',
};

describe('GitDiffService — mobile no-op', () => {
  it('does not subscribe, exec, or apply on mobile', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile, state } = makeExecFile(SUCCESS_RESPONSES);
    const svc = new GitDiffService(mgr as unknown as ThreadManager, { ...baseDeps(execFile), isMobile: true });
    svc.start();
    await svc.pollAll();
    expect(state.calls).toHaveLength(0);
    expect(mgr._listenerCount()).toBe(0);
    expect(mgr._applied).toHaveLength(0);
  });
});

describe('GitDiffService — full success path', () => {
  it('computes branch/base/diff-stat/ownerRepo and applies it to the thread', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile } = makeExecFile(SUCCESS_RESPONSES);
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    expect(mgr._applied).toHaveLength(1);
    expect(mgr._applied[0]).toEqual({
      id: 'a',
      info: {
        isGitRepo: true,
        branch: 'feat/offer-click-override',
        baseBranch: 'main',
        insertions: 60,
        deletions: 4,
        ownerRepo: { owner: 'acme', repo: 'hip-trip' },
      },
    });
  });
});

describe('GitDiffService — not a git repo', () => {
  it('short-circuits after the first check and applies isGitRepo:false', async () => {
    const mgr = fakeManager([makeThread('a', '/not-a-repo')]);
    const { execFile, state } = makeExecFile({ 'rev-parse --is-inside-work-tree': null });
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    expect(state.calls).toHaveLength(1);
    expect(mgr._applied).toEqual([{ id: 'a', info: { isGitRepo: false } }]);
  });
});

describe('GitDiffService — detached HEAD', () => {
  it('reports isGitRepo:true with no branch, and skips base-branch resolution', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile, state } = makeExecFile({
      'rev-parse --is-inside-work-tree': 'true',
      'rev-parse --abbrev-ref HEAD': 'HEAD',
    });
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    expect(state.calls).toHaveLength(2);
    expect(mgr._applied).toEqual([{ id: 'a', info: { isGitRepo: true } }]);
  });
});

describe('GitDiffService — sitting on the base branch', () => {
  it('marks isBaseBranch:true and never computes a diff', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile, state } = makeExecFile({
      'rev-parse --is-inside-work-tree': 'true',
      'rev-parse --abbrev-ref HEAD': 'main',
      'symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
    });
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    // is-inside-work-tree, abbrev-ref, symbolic-ref — no merge-base/diff/remote calls.
    expect(state.calls).toHaveLength(3);
    expect(mgr._applied).toEqual([
      { id: 'a', info: { isGitRepo: true, branch: 'main', baseBranch: 'main', isBaseBranch: true } },
    ]);
  });
});

describe('GitDiffService — base branch fallback chain', () => {
  it('falls back to origin/master when origin/HEAD symref and origin/main are both absent', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile } = makeExecFile({
      'rev-parse --is-inside-work-tree': 'true',
      'rev-parse --abbrev-ref HEAD': 'feat/x',
      // symbolic-ref fails (no response entry → null/non-zero exit)
      'show-ref --verify --quiet refs/remotes/origin/main': null,
      'show-ref --verify --quiet refs/remotes/origin/master': '', // success, empty stdout
      'merge-base HEAD origin/master': 'def456',
      'diff --shortstat def456': '',
      'remote get-url origin': 'git@github.com:acme/hip-trip.git',
    });
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    expect(mgr._applied[0].info).toMatchObject({ baseBranch: 'master', insertions: 0, deletions: 0 });
  });

  it('falls back to literal "main" when nothing resolves', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile } = makeExecFile({
      'rev-parse --is-inside-work-tree': 'true',
      'rev-parse --abbrev-ref HEAD': 'feat/x',
      // Every base-branch probe fails; no origin/main merge-base either.
    });
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    expect(mgr._applied[0].info).toMatchObject({ baseBranch: 'main', insertions: 0, deletions: 0 });
    expect(mgr._applied[0].info.ownerRepo).toBeUndefined();
  });
});

describe('GitDiffService — cwd coalescing', () => {
  it('computes once per cwd and applies to every thread sharing it', async () => {
    const threads = [makeThread('a', '/repo'), makeThread('b', '/repo'), makeThread('c', '/other')];
    const mgr = fakeManager(threads);
    const { execFile } = makeExecFile(SUCCESS_RESPONSES);
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    const ids = mgr._applied.map((x) => x.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('GitDiffService — concurrency cap', () => {
  it('runs at most 4 cwds concurrently', async () => {
    const threads = Array.from({ length: 6 }, (_, i) => makeThread(`t${i}`, `/repo${i}`));
    const mgr = fakeManager(threads);
    // Each cwd short-circuits after a single call (not a repo) so concurrency
    // is directly comparable across cwds, mirroring the StatusLineService test.
    const { execFile, state } = makeExecFile({ 'rev-parse --is-inside-work-tree': null });
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    expect(state.calls).toHaveLength(6);
    expect(state.maxActive).toBeLessThanOrEqual(4);
    expect(state.maxActive).toBe(4);
  });
});

describe('GitDiffService — cache TTL', () => {
  it('reuses the cached result within the TTL instead of re-execing', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile, state } = makeExecFile(SUCCESS_RESPONSES);
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile, { now: () => 1000 }));
    await svc.pollAll();
    const callsAfterFirst = state.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await svc.pollAll();
    expect(state.calls.length).toBe(callsAfterFirst);
    expect(mgr._applied).toHaveLength(2); // cached result still applied to the thread on each poll
  });
});

describe('GitDiffService — pokeThread', () => {
  it('bypasses the cache and forces a fresh computation', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile, state } = makeExecFile(SUCCESS_RESPONSES);
    const svc = new GitDiffService(mgr as unknown as ThreadManager, baseDeps(execFile));
    await svc.pollAll();
    const callsAfterFirst = state.calls.length;
    svc.pokeThread('a');
    // pokeThread's execFile call resolves on the next macrotask; flush it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('is a no-op on mobile', () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { execFile, state } = makeExecFile(SUCCESS_RESPONSES);
    const svc = new GitDiffService(mgr as unknown as ThreadManager, { ...baseDeps(execFile), isMobile: true });
    svc.pokeThread('a');
    expect(state.calls).toHaveLength(0);
  });
});

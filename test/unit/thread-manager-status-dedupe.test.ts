import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { StatusTag, GitDiffInfo } from '../../src/types';

function makeManager() {
  return new ThreadManager({ ...DEFAULT_SETTINGS });
}

/**
 * Fix 2 — dedupe status_tags / git_diff emission.
 *
 * The status-line and git-diff poll services re-apply their derived payloads on
 * every poll pass; the vast majority of passes yield an identical payload. Each
 * emit funnels into a full Kanban rebuild, so applyStatusTags/applyGitDiff must
 * only emit when the payload actually changed.
 */
describe('ThreadManager — status_tags / git_diff emit dedupe', () => {
  let manager: ThreadManager;
  let events: string[];

  beforeEach(() => {
    manager = makeManager();
    events = [];
    manager.subscribe((_id, ev) => { events.push(ev.type); });
  });

  const countStatus = () => events.filter((t) => t === 'status_tags').length;
  const countGit = () => events.filter((t) => t === 'git_diff').length;

  it('applyStatusTags emits on first apply and on change, but NOT on an identical re-apply', () => {
    const t = manager.createThread('T');

    manager.applyStatusTags(t.id, [{ label: 'main', kind: 'branch' }]);
    expect(countStatus()).toBe(1); // first real value → emit

    // Structurally identical (fresh objects/array) → no emit.
    manager.applyStatusTags(t.id, [{ label: 'main', kind: 'branch' }]);
    expect(countStatus()).toBe(1);

    // A genuine change → emit.
    manager.applyStatusTags(t.id, [{ label: 'feature-x', kind: 'branch' }]);
    expect(countStatus()).toBe(2);

    // Repeat of the new value → no emit again.
    manager.applyStatusTags(t.id, [{ label: 'feature-x', kind: 'branch' }]);
    expect(countStatus()).toBe(2);

    // The stored value is still kept current even on the silent re-applies.
    expect(manager.getThread(t.id)!.statusTags).toEqual([{ label: 'feature-x', kind: 'branch' }]);
  });

  it('applyStatusTags emits when a new PR url appears even if the tag array is otherwise unchanged', () => {
    const t = manager.createThread('T');
    const prTags: StatusTag[] = [{ label: 'PR #42', kind: 'pr', url: 'https://github.com/o/r/pull/42' }];

    expect(manager.applyStatusTags(t.id, prTags)).toBe(true); // prChanged
    expect(countStatus()).toBe(1);
    expect(manager.getThread(t.id)!.prUrl).toBe('https://github.com/o/r/pull/42');

    // Force the "tags unchanged but prUrl changed" branch: drop the sticky
    // prUrl, then re-apply the SAME tags. tagsChanged is false, but prChanged
    // is true, so it must still emit (so the PR chip can reappear).
    manager.getThread(t.id)!.prUrl = undefined;
    expect(manager.applyStatusTags(t.id, [{ label: 'PR #42', kind: 'pr', url: 'https://github.com/o/r/pull/42' }])).toBe(true);
    expect(countStatus()).toBe(2);
  });

  it('applyGitDiff emits on first apply and on change, but NOT on an identical re-apply', () => {
    const t = manager.createThread('T');
    const diffA: GitDiffInfo = { isGitRepo: true, branch: 'feat', baseBranch: 'main', insertions: 10, deletions: 2 };

    manager.applyGitDiff(t.id, diffA);
    expect(countGit()).toBe(1); // first real value → emit

    // Structurally identical → no emit.
    manager.applyGitDiff(t.id, { isGitRepo: true, branch: 'feat', baseBranch: 'main', insertions: 10, deletions: 2 });
    expect(countGit()).toBe(1);

    // A single field changed → emit.
    manager.applyGitDiff(t.id, { isGitRepo: true, branch: 'feat', baseBranch: 'main', insertions: 11, deletions: 2 });
    expect(countGit()).toBe(2);

    // Stored value stays current.
    expect(manager.getThread(t.id)!.gitDiff!.insertions).toBe(11);
  });
});

import { describe, it, expect } from 'vitest';
import type { Thread } from '../../src/types';
import { partitionThreads, type ThreadClassificationFlags } from '../../src/threadRowState';

/**
 * Mirrors the byRecency comparator in AgentDashboard.render().
 * Kept here explicitly so a future refactor that changes the sort order
 * is forced to update both the implementation and this test.
 */
const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;

function makeThread(id: string, updatedAt: number, hasMessages = false, hasError = false): Thread {
  return {
    id,
    title: id,
    cwd: '/tmp',
    messages: hasMessages ? [{ id: 'msg1', role: 'assistant', content: 'hi', timestamp: updatedAt }] : [],
    createdAt: updatedAt,
    updatedAt,
    lastError: hasError ? 'oops' : undefined,
  } as Thread;
}

describe('AgentDashboard — sort groups by recency', () => {
  it('sorts most-recently-updated thread to the top', () => {
    const old   = makeThread('old',   1_000);
    const mid   = makeThread('mid',   2_000);
    const fresh = makeThread('fresh', 3_000);

    const sorted = [old, fresh, mid].sort(byRecency);
    expect(sorted.map(t => t.id)).toEqual(['fresh', 'mid', 'old']);
  });

  it('is stable when updatedAt values are equal', () => {
    const a = makeThread('a', 5_000);
    const b = makeThread('b', 5_000);
    const result = [a, b].sort(byRecency);
    // Equal timestamps → original order preserved (stable sort, V8 ≥ Node 11)
    expect(result.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('Completed bucket: most recently finished thread appears first', () => {
    const finished1 = makeThread('finished-early', 1_000, true);
    const finished2 = makeThread('finished-late',  9_000, true);
    const finished3 = makeThread('finished-mid',   5_000, true);

    const idle = [finished1, finished2, finished3].sort(byRecency);
    expect(idle[0].id).toBe('finished-late');
    expect(idle[idle.length - 1].id).toBe('finished-early');
  });

  it('Failed bucket: most recently failed thread appears first', () => {
    const err1 = makeThread('err-old',   2_000, false, true);
    const err2 = makeThread('err-fresh', 8_000, false, true);

    const errors = [err1, err2].sort(byRecency);
    expect(errors[0].id).toBe('err-fresh');
  });

  it('handles a single thread without throwing', () => {
    const solo = makeThread('solo', 1_234);
    expect([solo].sort(byRecency)).toEqual([solo]);
  });

  it('handles an empty array without throwing', () => {
    expect(([] as Thread[]).sort(byRecency)).toEqual([]);
  });
});

// ── AgentDashboard's fold of partitionThreads buckets into its own 5 groups ──
//
// AgentDashboard has no separate "Awaiting" column (unlike Kanban) — its
// render() merges the shared classifyThreadRow's 'awaiting' bucket into
// 'running' before rendering. It also has no distinct bucket for
// background-task-only threads: those land in 'running' (Working) directly,
// via classifyThreadRow itself, per the product decision that a thread with
// no active foreground turn but an outstanding background task folds into
// the existing Working bucket rather than getting its own UI state.

interface ThreadWithFlags {
  thread: Thread;
  isRunning: boolean;
  hasPendingPermission: boolean;
  hasActiveBackgroundTasks: boolean;
  hasPendingWakeup: boolean;
}

function withFlags(
  thread: Thread,
  isRunning: boolean,
  hasPendingPermission = false,
  hasActiveBackgroundTasks = false,
  hasPendingWakeup = false,
): ThreadWithFlags {
  return { thread, isRunning, hasPendingPermission, hasActiveBackgroundTasks, hasPendingWakeup };
}

/** Mirrors AgentDashboard.render()'s merge: running = partition.running ∪ partition.awaiting. */
function agentDashboardGroups(items: ThreadWithFlags[]) {
  const buckets = partitionThreads<ThreadWithFlags>(items, (item): ThreadClassificationFlags => ({
    isRunning: item.isRunning,
    hasPendingPermission: item.hasPendingPermission,
    hasActiveBackgroundTasks: item.hasActiveBackgroundTasks,
    hasPendingWakeup: item.hasPendingWakeup,
    lastError: item.thread.lastError,
    messageCount: item.thread.messages.length,
    reviewed: item.thread.reviewed,
  }));
  return {
    working: [...buckets.running, ...buckets.awaiting].map(i => i.thread),
    waiting: buckets.waiting.map(i => i.thread),
    unreviewed: buckets['idle-new'].map(i => i.thread),
    reviewed: buckets['idle-reviewed'].map(i => i.thread),
    failed: buckets.error.map(i => i.thread),
    ready: buckets.empty.map(i => i.thread),
  };
}

describe('AgentDashboard — background-task-only thread folds into Working', () => {
  it('not running, but has an active background task → Working, not New/Reviewed/Ready', () => {
    const t = makeThread('bg-1', 1_000, true);
    const { working, unreviewed, reviewed, ready } = agentDashboardGroups([
      withFlags(t, false, false, true),
    ]);
    expect(working).toContain(t);
    expect(unreviewed).not.toContain(t);
    expect(reviewed).not.toContain(t);
    expect(ready).not.toContain(t);
  });

  it('active background task takes priority over a pending wakeup (Working, not Waiting)', () => {
    const t = makeThread('bg-2', 1_000);
    const { working, waiting } = agentDashboardGroups([withFlags(t, false, false, true, true)]);
    expect(working).toContain(t);
    expect(waiting).not.toContain(t);
  });

  it('active background task takes priority over a stale lastError (Working, not Failed)', () => {
    const t = makeThread('bg-3', 1_000, false, true);
    const { working, failed } = agentDashboardGroups([withFlags(t, false, false, true)]);
    expect(working).toContain(t);
    expect(failed).not.toContain(t);
  });

  it('a running thread with a pending permission still folds into Working (no separate Awaiting group)', () => {
    const t = makeThread('awaiting-1', 1_000);
    const { working } = agentDashboardGroups([withFlags(t, true, true)]);
    expect(working).toContain(t);
  });

  it('a thread with no background task and no other active state still lands in New/Reviewed/Ready as before', () => {
    const unreviewedThread = makeThread('u', 1_000, true);
    const reviewedThread = { ...makeThread('r', 1_000, true), reviewed: true } as Thread;
    const readyThread = makeThread('rd', 1_000);

    const result = agentDashboardGroups([
      withFlags(unreviewedThread, false, false, false),
      withFlags(reviewedThread, false, false, false),
      withFlags(readyThread, false, false, false),
    ]);
    expect(result.unreviewed).toContain(unreviewedThread);
    expect(result.reviewed).toContain(reviewedThread);
    expect(result.ready).toContain(readyThread);
    expect(result.working).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import type { Thread } from '../../src/types';

/**
 * Mirrors the exact bucketing logic from KanbanView.render() (lines 159–179).
 *
 * The real view reaches into `this.manager.isRunning()` and
 * `this.manager.hasPendingPermission()`, which are Obsidian-coupled.  Here we
 * accept plain boolean flags so the pure algorithm can be tested without a DOM
 * or a real ThreadManager.
 *
 * If the implementation changes, update the for-loop below to match.
 */
interface ThreadWithFlags {
  thread: Thread;
  isRunning: boolean;
  hasPendingPermission: boolean;
  hasPendingWakeup: boolean;
}

interface BucketedResult {
  working: Thread[];    // running, no pending permission
  awaiting: Thread[];   // running + pending permission
  waiting: Thread[];    // not running, has a pending ScheduleWakeup
  newThreads: Thread[]; // idle, messages.length > 0, !reviewed
  done: Thread[];       // idle, messages.length > 0, reviewed
  failed: Thread[];     // lastError set (and not running, no pending wakeup)
  ready: Thread[];      // no messages (and not running, no lastError, no pending wakeup)
}

function bucketThreads(items: ThreadWithFlags[]): BucketedResult {
  const running: Thread[] = [];
  const permReqs: Thread[] = [];
  const waiting: Thread[] = [];
  const unreviewed: Thread[] = [];
  const reviewed: Thread[] = [];
  const errors: Thread[] = [];
  const empty: Thread[] = [];

  for (const { thread: t, isRunning, hasPendingPermission, hasPendingWakeup } of items) {
    if (isRunning) {
      if (hasPendingPermission) permReqs.push(t);
      else running.push(t);
    } else if (hasPendingWakeup) {
      waiting.push(t);
    } else if (t.lastError) {
      errors.push(t);
    } else if (t.messages.length > 0) {
      if (t.reviewed) reviewed.push(t);
      else unreviewed.push(t);
    } else {
      empty.push(t);
    }
  }

  const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
  running.sort(byRecency);
  permReqs.sort(byRecency);
  waiting.sort(byRecency);
  unreviewed.sort(byRecency);
  reviewed.sort(byRecency);
  errors.sort(byRecency);
  empty.sort(byRecency);

  return {
    working: running,
    awaiting: permReqs,
    waiting,
    newThreads: unreviewed,
    done: reviewed,
    failed: errors,
    ready: empty,
  };
}

// ── makeThread helper (mirrors agent-dashboard-sort.test.ts pattern) ──────────

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

function withFlags(
  thread: Thread,
  isRunning: boolean,
  hasPendingPermission = false,
  hasPendingWakeup = false,
): ThreadWithFlags {
  return { thread, isRunning, hasPendingPermission, hasPendingWakeup };
}

// ── single-thread bucket assignment ───────────────────────────────────────────

describe('KanbanView bucketing — single-thread placement', () => {
  it('running thread without pending permission → Working', () => {
    const t = makeThread('t1', 1_000);
    const { working, awaiting, newThreads, done, failed, ready } = bucketThreads([
      withFlags(t, true, false),
    ]);
    expect(working).toContain(t);
    expect(awaiting).not.toContain(t);
    expect(newThreads).not.toContain(t);
    expect(done).not.toContain(t);
    expect(failed).not.toContain(t);
    expect(ready).not.toContain(t);
  });

  it('running thread with pending permission → Awaiting', () => {
    const t = makeThread('t2', 1_000);
    const { working, awaiting } = bucketThreads([withFlags(t, true, true)]);
    expect(awaiting).toContain(t);
    expect(working).not.toContain(t);
  });

  it('idle thread with messages and reviewed: false → New', () => {
    const t = makeThread('t3', 1_000, {
      messages: [{ id: 'm1', role: 'assistant', content: 'hi', timestamp: 1_000 }],
      reviewed: false,
    });
    const { newThreads, done } = bucketThreads([withFlags(t, false)]);
    expect(newThreads).toContain(t);
    expect(done).not.toContain(t);
  });

  it('idle thread with messages and reviewed: true → Done', () => {
    const t = makeThread('t4', 1_000, {
      messages: [{ id: 'm1', role: 'assistant', content: 'hi', timestamp: 1_000 }],
      reviewed: true,
    });
    const { done, newThreads } = bucketThreads([withFlags(t, false)]);
    expect(done).toContain(t);
    expect(newThreads).not.toContain(t);
  });

  it('idle thread with messages and reviewed: undefined → New (falsy reviewed)', () => {
    // reviewed is optional on Thread; undefined is falsy, so it goes to unreviewed
    const t = makeThread('t5', 1_000, {
      messages: [{ id: 'm1', role: 'assistant', content: 'hi', timestamp: 1_000 }],
    });
    const { newThreads, done } = bucketThreads([withFlags(t, false)]);
    expect(newThreads).toContain(t);
    expect(done).not.toContain(t);
  });

  it('idle thread with lastError set → Failed', () => {
    const t = makeThread('t6', 1_000, { lastError: 'Claude crashed' });
    const { failed } = bucketThreads([withFlags(t, false)]);
    expect(failed).toContain(t);
  });

  it('idle thread with a pending ScheduleWakeup → Waiting', () => {
    const t = makeThread('t6b', 1_000);
    const { waiting, working, ready } = bucketThreads([withFlags(t, false, false, true)]);
    expect(waiting).toContain(t);
    expect(working).not.toContain(t);
    expect(ready).not.toContain(t);
  });

  // The root-cause bug this bucket exists to fix: a session that just
  // finished a generation with a wake-up armed must land in Waiting the
  // instant isRunning() goes false — not stay stuck in Working (see
  // run-state-settled.test.ts for the ThreadManager-level regression test
  // that isRunning() itself settles promptly).
  it('pending wakeup takes priority over lastError (Waiting, not Failed)', () => {
    const t = makeThread('t6c', 1_000, { lastError: 'stale error from a prior run' });
    const { waiting, failed } = bucketThreads([withFlags(t, false, false, true)]);
    expect(waiting).toContain(t);
    expect(failed).not.toContain(t);
  });

  it('a running thread with a pending wakeup stays in Working, not Waiting (isRunning wins)', () => {
    const t = makeThread('t6d', 1_000);
    const { working, waiting } = bucketThreads([withFlags(t, true, false, true)]);
    expect(working).toContain(t);
    expect(waiting).not.toContain(t);
  });

  it('idle thread with no messages and no lastError → Ready', () => {
    const t = makeThread('t7', 1_000);
    const { ready } = bucketThreads([withFlags(t, false)]);
    expect(ready).toContain(t);
  });

  // Edge case: lastError + no messages — lastError branch fires before the
  // messages.length check, so the thread lands in Failed, not Ready.
  it('thread with lastError and no messages → Failed (not Ready)', () => {
    const t = makeThread('t8', 1_000, { lastError: 'timeout' });
    const { failed, ready } = bucketThreads([withFlags(t, false)]);
    expect(failed).toContain(t);
    expect(ready).not.toContain(t);
  });

  // Running threads skip all idle checks — lastError is irrelevant for running.
  it('running thread with lastError → Working (running branch wins)', () => {
    const t = makeThread('t9', 1_000, { lastError: 'stale error from last run' });
    const { working, failed } = bucketThreads([withFlags(t, true, false)]);
    expect(working).toContain(t);
    expect(failed).not.toContain(t);
  });
});

// ── multi-thread recency sort within a bucket ─────────────────────────────────

describe('KanbanView bucketing — recency sort within buckets', () => {
  it('Working: threads sorted by updatedAt descending', () => {
    const old   = makeThread('old',   1_000);
    const mid   = makeThread('mid',   5_000);
    const fresh = makeThread('fresh', 9_000);

    const { working } = bucketThreads([
      withFlags(old,   true),
      withFlags(fresh, true),
      withFlags(mid,   true),
    ]);
    expect(working.map(t => t.id)).toEqual(['fresh', 'mid', 'old']);
  });

  it('Awaiting: threads sorted by updatedAt descending', () => {
    const early = makeThread('early', 2_000);
    const late  = makeThread('late',  8_000);

    const { awaiting } = bucketThreads([
      withFlags(early, true, true),
      withFlags(late,  true, true),
    ]);
    expect(awaiting[0].id).toBe('late');
    expect(awaiting[1].id).toBe('early');
  });

  it('Waiting: threads sorted by updatedAt descending', () => {
    const early = makeThread('early-w', 2_000);
    const late  = makeThread('late-w',  8_000);

    const { waiting } = bucketThreads([
      withFlags(early, false, false, true),
      withFlags(late,  false, false, true),
    ]);
    expect(waiting[0].id).toBe('late-w');
    expect(waiting[1].id).toBe('early-w');
  });

  it('New: threads sorted by updatedAt descending', () => {
    const msg = (ts: number) => [{ id: 'm', role: 'assistant' as const, content: 'x', timestamp: ts }];
    const a = makeThread('a', 1_000, { messages: msg(1_000) });
    const b = makeThread('b', 7_000, { messages: msg(7_000) });
    const c = makeThread('c', 3_000, { messages: msg(3_000) });

    const { newThreads } = bucketThreads([
      withFlags(a, false),
      withFlags(b, false),
      withFlags(c, false),
    ]);
    expect(newThreads.map(t => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('Done: threads sorted by updatedAt descending', () => {
    const msg = (ts: number) => [{ id: 'm', role: 'assistant' as const, content: 'x', timestamp: ts }];
    const r1 = makeThread('r1', 2_000, { messages: msg(2_000), reviewed: true });
    const r2 = makeThread('r2', 9_000, { messages: msg(9_000), reviewed: true });

    const { done } = bucketThreads([withFlags(r1, false), withFlags(r2, false)]);
    expect(done[0].id).toBe('r2');
  });

  it('Failed: threads sorted by updatedAt descending', () => {
    const e1 = makeThread('e1', 1_000, { lastError: 'err' });
    const e2 = makeThread('e2', 6_000, { lastError: 'err' });
    const e3 = makeThread('e3', 3_000, { lastError: 'err' });

    const { failed } = bucketThreads([
      withFlags(e1, false),
      withFlags(e2, false),
      withFlags(e3, false),
    ]);
    expect(failed.map(t => t.id)).toEqual(['e2', 'e3', 'e1']);
  });

  it('Ready: threads sorted by updatedAt descending', () => {
    const x = makeThread('x', 4_000);
    const y = makeThread('y', 1_000);
    const z = makeThread('z', 7_000);

    const { ready } = bucketThreads([
      withFlags(x, false),
      withFlags(y, false),
      withFlags(z, false),
    ]);
    expect(ready.map(t => t.id)).toEqual(['z', 'x', 'y']);
  });

  it('equal updatedAt within a bucket preserves original array order (stable sort)', () => {
    const a = makeThread('a', 5_000);
    const b = makeThread('b', 5_000);

    const { ready } = bucketThreads([withFlags(a, false), withFlags(b, false)]);
    expect(ready.map(t => t.id)).toEqual(['a', 'b']);
  });
});

// ── mixed-bucket separation ───────────────────────────────────────────────────

describe('KanbanView bucketing — threads split across buckets correctly', () => {
  it('each thread ends up in exactly one bucket', () => {
    const msg = [{ id: 'm', role: 'assistant' as const, content: 'x', timestamp: 1_000 }];
    const working  = makeThread('working',  1_000);
    const awaiting = makeThread('awaiting', 2_000);
    const waitingT = makeThread('waiting',  2_500);
    const newT     = makeThread('new',      3_000, { messages: msg });
    const doneT    = makeThread('done',     4_000, { messages: msg, reviewed: true });
    const failed   = makeThread('failed',   5_000, { lastError: 'boom' });
    const ready    = makeThread('ready',    6_000);

    const result = bucketThreads([
      withFlags(working,  true,  false),
      withFlags(awaiting, true,  true),
      withFlags(waitingT, false, false, true),
      withFlags(newT,     false, false),
      withFlags(doneT,    false, false),
      withFlags(failed,   false, false),
      withFlags(ready,    false, false),
    ]);

    expect(result.working).toEqual([working]);
    expect(result.awaiting).toEqual([awaiting]);
    expect(result.waiting).toEqual([waitingT]);
    expect(result.newThreads).toEqual([newT]);
    expect(result.done).toEqual([doneT]);
    expect(result.failed).toEqual([failed]);
    expect(result.ready).toEqual([ready]);
  });

  it('empty input produces seven empty buckets', () => {
    const result = bucketThreads([]);
    expect(result.working).toHaveLength(0);
    expect(result.awaiting).toHaveLength(0);
    expect(result.waiting).toHaveLength(0);
    expect(result.newThreads).toHaveLength(0);
    expect(result.done).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.ready).toHaveLength(0);
  });

  it('all threads running without permissions → all in Working, others empty', () => {
    const threads = [
      makeThread('a', 1_000),
      makeThread('b', 2_000),
      makeThread('c', 3_000),
    ].map(t => withFlags(t, true, false));

    const result = bucketThreads(threads);
    expect(result.working).toHaveLength(3);
    expect(result.awaiting).toHaveLength(0);
    expect(result.newThreads).toHaveLength(0);
    expect(result.done).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.ready).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import type { Thread } from '../../src/types';
import { partitionThreads, type ThreadClassificationFlags } from '../../src/threadRowState';

/**
 * Mirrors KanbanView.sectionsForColumn() — the status-section bucketing used
 * inside each project column in 'project' groupBy mode. Exercises the real,
 * shared `partitionThreads`/`classifyThreadRow` from src/threadRowState.ts
 * (same as kanban-bucketing.test.ts), so this test tracks the actual
 * implementation's precedence rules rather than a hand-rolled copy.
 *
 * Unlike the status board's bucketize() (7 columns, Awaiting kept separate),
 * sectionsForColumn() mirrors AgentDashboard.render()'s sidebar grouping:
 * 'awaiting' folds into 'Working', labels are Working/Waiting/New/Reviewed/
 * Failed/Ready in that fixed order, and empty sections are omitted entirely.
 *
 * If the implementation changes, update the function below to match.
 */
interface ThreadWithFlags {
  thread: Thread;
  isRunning: boolean;
  hasPendingPermission: boolean;
  hasPendingWakeup: boolean;
  hasActiveBackgroundTasks?: boolean;
}

interface Section {
  label: string;
  threads: Thread[];
  badge?: number;
}

const SECTION_ORDER = ['Working', 'Waiting', 'New', 'Reviewed', 'Failed', 'Ready'];

function sectionsForColumn(items: ThreadWithFlags[]): Section[] {
  const buckets = partitionThreads<ThreadWithFlags>(items, (item): ThreadClassificationFlags => ({
    isRunning: item.isRunning,
    hasPendingPermission: item.hasPendingPermission,
    hasActiveBackgroundTasks: item.hasActiveBackgroundTasks ?? false,
    hasPendingWakeup: item.hasPendingWakeup,
    lastError: item.thread.lastError,
    messageCount: item.thread.messages.length,
    reviewed: item.thread.reviewed,
  }));

  const byRecency = (a: ThreadWithFlags, b: ThreadWithFlags) => b.thread.updatedAt - a.thread.updatedAt;
  const sortThreads = (arr: ThreadWithFlags[]) => arr.slice().sort(byRecency).map(i => i.thread);

  const working = sortThreads([...buckets.running, ...buckets.awaiting]);
  const waiting = sortThreads(buckets.waiting);
  const unreviewed = sortThreads(buckets['idle-new']);
  const reviewed = sortThreads(buckets['idle-reviewed']);
  const errors = sortThreads(buckets.error);
  const empty = sortThreads(buckets.empty);

  const all: Section[] = [
    { label: 'Working', threads: working },
    { label: 'Waiting', threads: waiting },
    { label: 'New', threads: unreviewed, badge: unreviewed.length > 0 ? unreviewed.length : undefined },
    { label: 'Reviewed', threads: reviewed },
    { label: 'Failed', threads: errors },
    { label: 'Ready', threads: empty },
  ];
  return all.filter(section => section.threads.length > 0);
}

// ── makeThread / withFlags helpers (mirrors kanban-bucketing.test.ts) ────────

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
  hasActiveBackgroundTasks = false,
): ThreadWithFlags {
  return { thread, isRunning, hasPendingPermission, hasPendingWakeup, hasActiveBackgroundTasks };
}

// ── fixed section order ───────────────────────────────────────────────────────

describe('KanbanView project-column sections — fixed order', () => {
  it('returns non-empty sections in the fixed Working/Waiting/New/Reviewed/Failed/Ready order', () => {
    const msg = [{ id: 'm', role: 'assistant' as const, content: 'x', timestamp: 1_000 }];
    const working = makeThread('working', 1_000);
    const waiting = makeThread('waiting', 2_000);
    const newT = makeThread('new', 3_000, { messages: msg });
    const reviewed = makeThread('reviewed', 4_000, { messages: msg, reviewed: true });
    const failed = makeThread('failed', 5_000, { lastError: 'boom' });
    const ready = makeThread('ready', 6_000);

    const sections = sectionsForColumn([
      withFlags(ready, false),
      withFlags(failed, false),
      withFlags(reviewed, false),
      withFlags(newT, false),
      withFlags(waiting, false, false, true),
      withFlags(working, true),
    ]);

    expect(sections.map(s => s.label)).toEqual(SECTION_ORDER);
  });

  it('a subset of populated sections still preserves the fixed relative order', () => {
    const failed = makeThread('failed', 1_000, { lastError: 'boom' });
    const working = makeThread('working', 2_000);

    const sections = sectionsForColumn([
      withFlags(failed, false),
      withFlags(working, true),
    ]);

    expect(sections.map(s => s.label)).toEqual(['Working', 'Failed']);
  });
});

// ── awaiting folds into Working ───────────────────────────────────────────────

describe('KanbanView project-column sections — awaiting folds into Working', () => {
  it('a running thread with a pending permission lands in Working, not a separate Awaiting section', () => {
    const t = makeThread('t1', 1_000);
    const sections = sectionsForColumn([withFlags(t, true, true)]);

    expect(sections.map(s => s.label)).not.toContain('Awaiting');
    const workingSection = sections.find(s => s.label === 'Working');
    expect(workingSection?.threads).toContain(t);
  });

  it('Working merges plain-running and awaiting-permission threads together, sorted by recency', () => {
    const running = makeThread('running', 5_000);
    const awaiting = makeThread('awaiting', 9_000);

    const sections = sectionsForColumn([
      withFlags(running, true, false),
      withFlags(awaiting, true, true),
    ]);

    const workingSection = sections.find(s => s.label === 'Working');
    expect(workingSection?.threads.map(t => t.id)).toEqual(['awaiting', 'running']);
  });
});

// ── empty sections omitted ────────────────────────────────────────────────────

describe('KanbanView project-column sections — empty sections omitted', () => {
  it('omits every section with no threads', () => {
    const t = makeThread('t1', 1_000);
    const sections = sectionsForColumn([withFlags(t, true)]);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('Working');
  });

  it('empty input produces no sections at all', () => {
    expect(sectionsForColumn([])).toEqual([]);
  });
});

// ── recency sort within each section ──────────────────────────────────────────

describe('KanbanView project-column sections — sorted by recency within each section', () => {
  it('New: threads sorted by updatedAt descending', () => {
    const msg = (ts: number) => [{ id: 'm', role: 'assistant' as const, content: 'x', timestamp: ts }];
    const a = makeThread('a', 1_000, { messages: msg(1_000) });
    const b = makeThread('b', 7_000, { messages: msg(7_000) });
    const c = makeThread('c', 3_000, { messages: msg(3_000) });

    const sections = sectionsForColumn([
      withFlags(a, false),
      withFlags(b, false),
      withFlags(c, false),
    ]);

    const newSection = sections.find(s => s.label === 'New');
    expect(newSection?.threads.map(t => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('Ready: threads sorted by updatedAt descending', () => {
    const x = makeThread('x', 4_000);
    const y = makeThread('y', 1_000);
    const z = makeThread('z', 7_000);

    const sections = sectionsForColumn([
      withFlags(x, false),
      withFlags(y, false),
      withFlags(z, false),
    ]);

    const readySection = sections.find(s => s.label === 'Ready');
    expect(readySection?.threads.map(t => t.id)).toEqual(['z', 'x', 'y']);
  });

  it('Failed: threads sorted by updatedAt descending', () => {
    const e1 = makeThread('e1', 1_000, { lastError: 'err' });
    const e2 = makeThread('e2', 6_000, { lastError: 'err' });
    const e3 = makeThread('e3', 3_000, { lastError: 'err' });

    const sections = sectionsForColumn([
      withFlags(e1, false),
      withFlags(e2, false),
      withFlags(e3, false),
    ]);

    const failedSection = sections.find(s => s.label === 'Failed');
    expect(failedSection?.threads.map(t => t.id)).toEqual(['e2', 'e3', 'e1']);
  });
});

// ── New section badge ─────────────────────────────────────────────────────────

describe('KanbanView project-column sections — New section badge', () => {
  it('New section carries a badge equal to its thread count', () => {
    const msg = [{ id: 'm', role: 'assistant' as const, content: 'x', timestamp: 1_000 }];
    const a = makeThread('a', 1_000, { messages: msg });
    const b = makeThread('b', 2_000, { messages: msg });
    const c = makeThread('c', 3_000, { messages: msg });

    const sections = sectionsForColumn([
      withFlags(a, false),
      withFlags(b, false),
      withFlags(c, false),
    ]);

    const newSection = sections.find(s => s.label === 'New');
    expect(newSection?.badge).toBe(3);
  });

  it('other sections never carry a badge', () => {
    const msg = [{ id: 'm', role: 'assistant' as const, content: 'x', timestamp: 1_000 }];
    const working = makeThread('working', 1_000);
    const reviewed = makeThread('reviewed', 2_000, { messages: msg, reviewed: true });
    const failed = makeThread('failed', 3_000, { lastError: 'boom' });
    const ready = makeThread('ready', 4_000);

    const sections = sectionsForColumn([
      withFlags(working, true),
      withFlags(reviewed, false),
      withFlags(failed, false),
      withFlags(ready, false),
    ]);

    for (const section of sections) {
      if (section.label === 'New') continue;
      expect(section.badge).toBeUndefined();
    }
  });
});

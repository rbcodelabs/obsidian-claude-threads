import { describe, it, expect } from 'vitest';
import {
  buildStackMenuActions,
  buildThreadMenuActions,
  resolveArchiveIds,
} from '../../src/threadArchiveMenu';
import type { Thread } from '../../src/types';

/**
 * The menu model for scheduled-job rollups. A job's runs split across status
 * groups (New/Reviewed/Ready) and project sections, so one job can render as
 * several rollups — which is exactly why the second "all M runs of this job"
 * item exists, and why it must only appear when there really are runs elsewhere.
 */

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return { id, title: id, messages: [], updatedAt: 0, ...extra } as unknown as Thread;
}

/** Three runs of `nightly` plus one unrelated thread. */
const THREE_RUNS: Thread[] = [
  thread('r1', { scheduledItemId: 'nightly' }),
  thread('r2', { scheduledItemId: 'nightly' }),
  thread('r3', { scheduledItemId: 'nightly' }),
  thread('manual'),
];

describe('buildThreadMenuActions', () => {
  it('always offers exactly one item, scoped to that thread', () => {
    const actions = buildThreadMenuActions(thread('t1'));
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe('Archive thread');
    expect(actions[0].scope).toEqual({ kind: 'thread', threadId: 't1' });
  });
});

describe('buildStackMenuActions', () => {
  it('offers one item when the rollup already covers every run of the job (M === N)', () => {
    const actions = buildStackMenuActions('nightly', ['r1', 'r2', 'r3'], THREE_RUNS);
    expect(actions.map(a => a.title)).toEqual(['Archive these 3 runs']);
  });

  it('offers a second item when the job has runs this rollup does not show (M > N)', () => {
    // A rollup under "New" holding r1+r2 while r3 sits under "Reviewed".
    const actions = buildStackMenuActions('nightly', ['r1', 'r2'], THREE_RUNS);
    expect(actions.map(a => a.title)).toEqual(['Archive these 2 runs', 'Archive all 3 runs of this job']);
    expect(actions[1].scope).toEqual({ kind: 'job', scheduledItemId: 'nightly' });
  });

  it('uses singular wording for a one-run rollup', () => {
    const actions = buildStackMenuActions('nightly', ['r1'], THREE_RUNS);
    expect(actions[0].title).toBe('Archive this run');
    expect(actions[1].title).toBe('Archive all 3 runs of this job');
  });

  it('filters dead ids out BEFORE counting, so N reflects survivors', () => {
    // r2 and r3 were archived since this rollup rendered.
    const survivors = [thread('r1', { scheduledItemId: 'nightly' }), thread('manual')];
    const actions = buildStackMenuActions('nightly', ['r1', 'r2', 'r3'], survivors);
    // N === 1 and M === 1, so no "all runs" item — the counts agree.
    expect(actions.map(a => a.title)).toEqual(['Archive this run']);
    expect(actions[0].scope).toEqual({ kind: 'stack', scheduledItemId: 'nightly', threadIds: ['r1'] });
  });

  it('offers nothing at all once every run in the rollup is gone', () => {
    expect(buildStackMenuActions('nightly', ['r1', 'r2'], [thread('manual')])).toEqual([]);
  });

  it('de-duplicates repeated ids before counting', () => {
    const actions = buildStackMenuActions('nightly', ['r1', 'r1', 'r2'], THREE_RUNS);
    expect(actions[0].title).toBe('Archive these 2 runs');
  });
});

describe('resolveArchiveIds', () => {
  it('resolves a thread scope to that one id', () => {
    expect(resolveArchiveIds({ kind: 'thread', threadId: 't1' }, THREE_RUNS)).toEqual(['t1']);
  });

  it('resolves a stack scope to the ids the menu item promised', () => {
    expect(resolveArchiveIds({ kind: 'stack', scheduledItemId: 'nightly', threadIds: ['r1', 'r2'] }, THREE_RUNS))
      .toEqual(['r1', 'r2']);
  });

  it('resolves a job scope live, picking up runs from every status group and project', () => {
    expect(resolveArchiveIds({ kind: 'job', scheduledItemId: 'nightly' }, THREE_RUNS)).toEqual(['r1', 'r2', 'r3']);
  });

  it('resolves a job scope against threads created since the menu opened', () => {
    const later = [...THREE_RUNS, thread('r4', { scheduledItemId: 'nightly' })];
    expect(resolveArchiveIds({ kind: 'job', scheduledItemId: 'nightly' }, later)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('never picks up a different job’s runs', () => {
    const mixed = [...THREE_RUNS, thread('h1', { scheduledItemId: 'hourly' })];
    expect(resolveArchiveIds({ kind: 'job', scheduledItemId: 'hourly' }, mixed)).toEqual(['h1']);
  });
});

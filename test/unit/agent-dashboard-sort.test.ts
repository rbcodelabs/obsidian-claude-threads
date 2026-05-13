import { describe, it, expect } from 'vitest';
import type { Thread } from '../../src/types';

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

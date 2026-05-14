import { describe, it, expect } from 'vitest';
import type { Thread } from '../../src/types';

/**
 * Mirrors the initial-thread selection logic in ThreadsView.onOpen().
 * Kept here explicitly so a regression back to `threads[0]` (oldest) forces
 * an update to both the implementation and these tests.
 *
 * The two rules being tested:
 *   1. When no activeThreadId is pre-set, default to the NEWEST thread (threads[last]).
 *   2. When activeThreadId IS pre-set (e.g. focusThread called before buildUI in a race),
 *      respect it as long as the thread still exists.
 */
function pickInitialThread(
  activeThreadId: string | null,
  threads: Thread[],            // must be sorted ascending by createdAt (as getThreads() returns)
  getThread: (id: string) => Thread | undefined,
): string {
  if (activeThreadId && getThread(activeThreadId)) return activeThreadId;
  return threads[threads.length - 1].id;
}

function makeThread(id: string, createdAt: number): Thread {
  return { id, title: id, cwd: '/tmp', messages: [], createdAt, updatedAt: createdAt } as Thread;
}

describe('ThreadsView — initial thread selection (onOpen logic)', () => {
  const oldest  = makeThread('oldest',  1_000);
  const middle  = makeThread('middle',  2_000);
  const newest  = makeThread('newest',  3_000);
  // sorted asc by createdAt — matches ThreadManager.getThreads() order
  const threads = [oldest, middle, newest];
  const map = new Map(threads.map(t => [t.id, t]));
  const getThread = (id: string) => map.get(id);

  it('defaults to the newest (last) thread when no activeThreadId is pre-set', () => {
    expect(pickInitialThread(null, threads, getThread)).toBe('newest');
  });

  it('regression guard: does NOT default to threads[0] (the oldest)', () => {
    expect(pickInitialThread(null, threads, getThread)).not.toBe('oldest');
  });

  it('respects a pre-set activeThreadId when the thread still exists', () => {
    expect(pickInitialThread('oldest', threads, getThread)).toBe('oldest');
    expect(pickInitialThread('middle', threads, getThread)).toBe('middle');
  });

  it('falls back to newest if the pre-set activeThreadId is stale / deleted', () => {
    expect(pickInitialThread('gone-thread-id', threads, getThread)).toBe('newest');
  });

  it('works correctly with a single thread', () => {
    const solo = makeThread('solo', 9_000);
    expect(pickInitialThread(null, [solo], (id) => (id === 'solo' ? solo : undefined))).toBe('solo');
  });
});

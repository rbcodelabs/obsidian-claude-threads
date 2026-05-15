import { describe, it, expect } from 'vitest';
import type { Thread } from '../../src/types';

/**
 * Mirrors the getDisplayText() logic in ThreadsView.
 * The Obsidian workspace tab title should reflect the active thread's title
 * so users can see which thread they're in at a glance.
 *
 * Rules:
 *   1. When an active thread exists, return its title.
 *   2. Fall back to 'Claude Threads' when there is no active thread.
 *   3. Fall back to 'Claude Threads' if the activeThreadId is stale (thread deleted).
 */
function getDisplayText(
  activeThreadId: string | null,
  getThread: (id: string) => Thread | undefined,
): string {
  if (activeThreadId) {
    const thread = getThread(activeThreadId);
    if (thread) return thread.title;
  }
  return 'Claude Threads';
}

function makeThread(id: string, title: string): Thread {
  return { id, title, cwd: '/tmp', messages: [], createdAt: 1_000, updatedAt: 1_000 } as Thread;
}

describe('ThreadsView — getDisplayText()', () => {
  const threadA = makeThread('a', 'Fix authentication bug');
  const threadB = makeThread('b', 'Thread 2');
  const map = new Map([['a', threadA], ['b', threadB]]);
  const getThread = (id: string) => map.get(id);

  it('returns the active thread title when a thread is selected', () => {
    expect(getDisplayText('a', getThread)).toBe('Fix authentication bug');
  });

  it('returns the active thread title even for a default "Thread N" name', () => {
    expect(getDisplayText('b', getThread)).toBe('Thread 2');
  });

  it('falls back to "Claude Threads" when no thread is active (null)', () => {
    expect(getDisplayText(null, getThread)).toBe('Claude Threads');
  });

  it('falls back to "Claude Threads" when activeThreadId is stale / deleted', () => {
    expect(getDisplayText('gone-id', getThread)).toBe('Claude Threads');
  });

  it('picks up a renamed title immediately after renameThread() mutates thread.title', () => {
    const thread = makeThread('c', 'Thread 3');
    const lookup = (id: string) => (id === 'c' ? thread : undefined);
    expect(getDisplayText('c', lookup)).toBe('Thread 3');
    // simulate applyAutoTitle / renameThread updating thread.title in place
    thread.title = 'Refactor auth flow';
    expect(getDisplayText('c', lookup)).toBe('Refactor auth flow');
  });
});

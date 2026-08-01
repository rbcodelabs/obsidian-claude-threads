import { describe, it, expect } from 'vitest';
import { partitionScheduledStacks } from '../../src/scheduledStacks';
import type { Thread } from '../../src/types';

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

describe('partitionScheduledStacks — grouping', () => {
  it('groups threads that share a scheduledItemId into one stack', () => {
    const a = makeThread('a', 1_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });
    const b = makeThread('b', 2_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });

    const { stacks, standalone } = partitionScheduledStacks([a, b]);

    expect(stacks).toHaveLength(1);
    expect(stacks[0].scheduledItemId).toBe('job1');
    expect(stacks[0].threads.map(t => t.id)).toEqual(['b', 'a']); // newest first
    expect(standalone).toHaveLength(0);
  });

  it('keeps distinct scheduledItemIds in separate stacks', () => {
    const a = makeThread('a', 1_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });
    const b = makeThread('b', 2_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });
    const c = makeThread('c', 3_000, { scheduledItemId: 'job2', scheduledItemName: 'Digest' });
    const d = makeThread('d', 4_000, { scheduledItemId: 'job2', scheduledItemName: 'Digest' });

    const { stacks } = partitionScheduledStacks([a, b, c, d]);

    expect(stacks).toHaveLength(2);
    expect(stacks.map(s => s.scheduledItemId).sort()).toEqual(['job1', 'job2']);
  });

  it('threads with no scheduledItemId always fall through to standalone', () => {
    const manual = makeThread('manual', 1_000);
    const a = makeThread('a', 2_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });
    const b = makeThread('b', 3_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });

    const { stacks, standalone } = partitionScheduledStacks([manual, a, b]);

    expect(standalone).toEqual([manual]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].threads.map(t => t.id)).toEqual(['b', 'a']);
  });

  it('derives the stack display name from the newest run in the group', () => {
    const older = makeThread('older', 1_000, { scheduledItemId: 'job1', scheduledItemName: 'Old Name' });
    const newer = makeThread('newer', 2_000, { scheduledItemId: 'job1', scheduledItemName: 'New Name' });

    const { stacks } = partitionScheduledStacks([older, newer]);

    expect(stacks[0].scheduledItemName).toBe('New Name');
  });

  it('falls back to the scheduledItemId as the display name when scheduledItemName is missing', () => {
    const a = makeThread('a', 1_000, { scheduledItemId: 'job1' });
    const b = makeThread('b', 2_000, { scheduledItemId: 'job1' });

    const { stacks } = partitionScheduledStacks([a, b]);

    expect(stacks[0].scheduledItemName).toBe('job1');
  });
});

describe('partitionScheduledStacks — minCount threshold', () => {
  it('default minCount=2: a group of exactly 1 falls through to standalone', () => {
    const solo = makeThread('solo', 1_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });

    const { stacks, standalone } = partitionScheduledStacks([solo]);

    expect(stacks).toHaveLength(0);
    expect(standalone).toEqual([solo]);
  });

  it('default minCount=2: a group of exactly 2 becomes a stack (boundary is inclusive)', () => {
    const a = makeThread('a', 1_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });
    const b = makeThread('b', 2_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });

    const { stacks, standalone } = partitionScheduledStacks([a, b]);

    expect(stacks).toHaveLength(1);
    expect(standalone).toHaveLength(0);
  });

  it('minCount=1: every distinct job becomes its own stack, even a lone run', () => {
    const solo = makeThread('solo', 1_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });

    const { stacks, standalone } = partitionScheduledStacks([solo], 1);

    expect(stacks).toHaveLength(1);
    expect(stacks[0].threads).toEqual([solo]);
    expect(standalone).toHaveLength(0);
  });

  it('a higher minCount can push an otherwise-stackable group back to standalone', () => {
    const a = makeThread('a', 1_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });
    const b = makeThread('b', 2_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });

    const { stacks, standalone } = partitionScheduledStacks([a, b], 3);

    expect(stacks).toHaveLength(0);
    expect(standalone.map(t => t.id).sort()).toEqual(['a', 'b']);
  });
});

describe('partitionScheduledStacks — ordering', () => {
  it('sorts threads within a stack newest-first regardless of input order', () => {
    const oldest = makeThread('oldest', 1_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });
    const newest = makeThread('newest', 3_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });
    const middle = makeThread('middle', 2_000, { scheduledItemId: 'job1', scheduledItemName: 'Triage' });

    const { stacks } = partitionScheduledStacks([oldest, newest, middle]);

    expect(stacks[0].threads.map(t => t.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('standalone threads preserve their original relative order', () => {
    const a = makeThread('a', 3_000);
    const b = makeThread('b', 1_000);
    const c = makeThread('c', 2_000);

    const { standalone } = partitionScheduledStacks([a, b, c]);

    expect(standalone.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('empty input produces no stacks and no standalone threads', () => {
    const { stacks, standalone } = partitionScheduledStacks([]);
    expect(stacks).toHaveLength(0);
    expect(standalone).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ScheduledItem } from '../../src/types';
import { deleteScheduledActivity, scheduledActivityForThread, scheduledActivitySummary } from '../../src/scheduledActivity';

function item(overrides: Partial<ScheduledItem>): ScheduledItem {
  return {
    id: 'item',
    name: 'Item',
    prompt: 'Do the thing',
    schedule: { type: 'interval', intervalSeconds: 300 },
    enabled: true,
    targetThreadId: 'thread-1',
    nextRun: 10_000,
    ...overrides,
  };
}

describe('scheduledActivityForThread', () => {
  it('classifies a durable ScheduleWakeup as one-time activity, never a 0s loop', () => {
    const activity = scheduledActivityForThread([
      item({ id: 'wake', origin: 'wakeup', schedule: { type: 'once', fireAt: 8_000 }, nextRun: 8_000 }),
    ], 'thread-1');

    expect(activity).toEqual([expect.objectContaining({ id: 'wake', kind: 'wakeup', nextRun: 8_000 })]);
    expect(scheduledActivitySummary(activity, 0)).toBe('Resumes in 8s');
    expect(scheduledActivitySummary(activity, 0)).not.toContain('0s loop');
  });

  it('includes only enabled wakeups and intervals for the requested thread', () => {
    const activity = scheduledActivityForThread([
      item({ id: 'loop' }),
      item({ id: 'disabled', enabled: false }),
      item({ id: 'daily', schedule: { type: 'daily', timeOfDay: '09:00' } }),
      item({ id: 'other', targetThreadId: 'thread-2' }),
    ], 'thread-1');

    expect(activity.map((entry) => entry.id)).toEqual(['loop']);
  });

  it('orders combined activity by next run and summarizes the nearest plus the remaining count', () => {
    const activity = scheduledActivityForThread([
      item({ id: 'loop', nextRun: 20_000 }),
      item({ id: 'wake', origin: 'wakeup', schedule: { type: 'once', fireAt: 10_000 }, nextRun: 10_000 }),
    ], 'thread-1');

    expect(activity.map((entry) => entry.id)).toEqual(['wake', 'loop']);
    expect(scheduledActivitySummary(activity, 0)).toBe('Resumes in 10s · +1');
  });

  it('uses the interval label for a recurring loop', () => {
    const activity = scheduledActivityForThread([item({ id: 'loop' })], 'thread-1');
    expect(scheduledActivitySummary(activity, 0)).toBe('Every 5m');
  });

  it('omits malformed wakeups instead of pretending they are due now', () => {
    const activity = scheduledActivityForThread([
      item({ id: 'wake', origin: 'wakeup', schedule: { type: 'once' }, nextRun: undefined }),
    ], 'thread-1');
    expect(activity).toEqual([]);
  });
});

describe('deleteScheduledActivity', () => {
  it('notifies the deleted wakeup target even if navigation changes while delete persistence waits', async () => {
    let finishDelete!: () => void;
    const deleteItem = vi.fn(() => new Promise<void>((resolve) => { finishDelete = resolve; }));
    const notifyWakeupChanged = vi.fn();
    const activity = scheduledActivityForThread([
      item({ id: 'wake', origin: 'wakeup', schedule: { type: 'once', fireAt: 8_000 }, nextRun: 8_000 }),
    ], 'thread-1')[0];

    const deletion = deleteScheduledActivity(activity, deleteItem, notifyWakeupChanged);
    const activeThreadId = 'thread-2';
    finishDelete();
    await deletion;

    expect(activeThreadId).toBe('thread-2');
    expect(deleteItem).toHaveBeenCalledWith('wake');
    expect(notifyWakeupChanged).toHaveBeenCalledWith('thread-1');
    expect(notifyWakeupChanged).toHaveBeenCalledTimes(1);
  });

  it('notifies the captured wakeup thread exactly once when in-memory removal succeeds but persistence rejects', async () => {
    const items = new Map([['wake', true]]);
    const deleteItem = vi.fn(async (id: string) => {
      items.delete(id);
      throw new Error('disk full');
    });
    const notifyWakeupChanged = vi.fn();
    const activity = scheduledActivityForThread([
      item({ id: 'wake', origin: 'wakeup', schedule: { type: 'once', fireAt: 8_000 }, nextRun: 8_000 }),
    ], 'thread-1')[0];

    await expect(deleteScheduledActivity(activity, deleteItem, notifyWakeupChanged)).rejects.toThrow('disk full');

    expect(items.has('wake')).toBe(false);
    expect(notifyWakeupChanged).toHaveBeenCalledTimes(1);
    expect(notifyWakeupChanged).toHaveBeenCalledWith('thread-1');
  });
});

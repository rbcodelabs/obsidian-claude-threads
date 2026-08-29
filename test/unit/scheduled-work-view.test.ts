import { describe, expect, it } from 'vitest';
import type { ScheduledItem } from '../../src/types';
import {
  classifyScheduledItems,
  formatNextOccurrence,
  formatRelativeTime,
} from '../../src/scheduledWorkView';

function item(overrides: Partial<ScheduledItem> = {}): ScheduledItem {
  return {
    id: 'item',
    name: 'Scheduled item',
    prompt: 'Do useful work.',
    schedule: { type: 'daily', timeOfDay: '09:00' },
    enabled: true,
    ...overrides,
  };
}

describe('scheduled work dashboard helpers', () => {
  it('sorts visible next-up work by canonical nextRun and omits disabled and system items', () => {
    const result = classifyScheduledItems([
      item({ id: 'late', nextRun: 5_000 }),
      item({ id: 'disabled', enabled: false, nextRun: 1_000 }),
      item({ id: 'heartbeat', nextRun: 500, isOrchestratorHeartbeat: true }),
      item({ id: 'early', nextRun: 2_000 }),
      item({ id: 'missing-next' }),
    ]);

    expect(result.nextUp.map((entry) => entry.id)).toEqual(['early', 'late']);
  });

  it('groups recurring jobs separately from loops and wakeups', () => {
    const result = classifyScheduledItems([
      item({ id: 'recurring' }),
      item({ id: 'loop', targetThreadId: 'thread-1' }),
      item({
        id: 'wakeup',
        targetThreadId: 'thread-2',
        origin: 'wakeup',
        schedule: { type: 'once', fireAt: 10_000 },
      }),
      item({ id: 'heartbeat', isOrchestratorHeartbeat: true }),
    ]);

    expect(result.recurring.map((entry) => entry.id)).toEqual(['recurring']);
    expect(result.threadSpecific.map((entry) => entry.id)).toEqual(['loop', 'wakeup']);
  });

  it('formats future and overdue occurrences with run/check wording', () => {
    const now = new Date('2026-08-29T12:00:00.000Z').getTime();

    expect(formatRelativeTime(now + 90_000, now)).toBe('in 2m');
    expect(formatNextOccurrence(item({ nextRun: now - 1_000 }), now)).toEqual({
      label: 'Next run',
      relative: 'Overdue — catching up',
      exact: new Date(now - 1_000).toLocaleString(),
      overdue: true,
    });
    expect(formatNextOccurrence(item({ nextRun: now + 3_600_000, gate: { command: 'test -s queue' } }), now)).toEqual({
      label: 'Next check',
      relative: 'in 1h',
      exact: new Date(now + 3_600_000).toLocaleString(),
      overdue: false,
    });
  });

  it('returns no next occurrence for paused or unscheduled items', () => {
    expect(formatNextOccurrence(item({ enabled: false, nextRun: 10_000 }), 0)).toBeNull();
    expect(formatNextOccurrence(item({ nextRun: undefined }), 0)).toBeNull();
  });
});

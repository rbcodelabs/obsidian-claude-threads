import { describe, expect, it } from 'vitest';
import type { ScheduledItem } from '../../src/types';
import {
  classifyScheduledItems,
  describeScheduledExecution,
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
  it('sorts each group by next run with paused items last and omits system items', () => {
    const result = classifyScheduledItems([
      item({ id: 'late', nextRun: 5_000 }),
      item({ id: 'disabled', enabled: false, nextRun: 1_000 }),
      item({ id: 'heartbeat', nextRun: 500, isOrchestratorHeartbeat: true }),
      item({ id: 'early', nextRun: 2_000 }),
      item({ id: 'missing-next' }),
    ]);

    expect(result.recurring.map((entry) => entry.id)).toEqual([
      'early',
      'late',
      'missing-next',
      'disabled',
    ]);
    expect('nextUp' in result).toBe(false);
  });

  it('sorts thread-specific work independently of recurring jobs', () => {
    const result = classifyScheduledItems([
      item({ id: 'paused-loop', enabled: false, targetThreadId: 'thread-1', nextRun: 1_000 }),
      item({ id: 'later-loop', targetThreadId: 'thread-2', nextRun: 5_000 }),
      item({ id: 'early-loop', targetThreadId: 'thread-3', nextRun: 2_000 }),
    ]);

    expect(result.threadSpecific.map((entry) => entry.id)).toEqual([
      'early-loop',
      'later-loop',
      'paused-loop',
    ]);
  });

  it('describes new-thread execution from the current global harness and model', () => {
    expect(describeScheduledExecution(item(), 'codex', 'gpt-5.6-codex')).toEqual({
      summary: 'New thread · Codex · gpt-5.6-codex',
      detail: 'Creates a new thread using the current global Codex harness and gpt-5.6-codex model at fire time.',
      missingTarget: false,
    });
    expect(describeScheduledExecution(item(), 'claude', '')).toEqual({
      summary: 'New thread · Claude · CLI default model',
      detail: 'Creates a new thread using the current global Claude harness and the CLI default model at fire time.',
      missingTarget: false,
    });
  });

  it('describes thread execution from the persisted target and flags missing targets', () => {
    const loop = item({ targetThreadId: 'thread-1' });
    expect(describeScheduledExecution(loop, 'claude', 'sonnet', {
      agentHarness: 'codex',
      model: 'gpt-5.6-codex',
    })).toEqual({
      summary: 'Existing thread · Codex · gpt-5.6-codex',
      detail: 'Resumes the target thread using its persisted Codex harness and its persisted gpt-5.6-codex model.',
      missingTarget: false,
    });
    expect(describeScheduledExecution(loop, 'claude', '')).toEqual({
      summary: 'Target thread missing · falls back to new thread',
      detail: 'The target thread is missing. At fire time this item falls back to a new thread using the current global Claude harness and the CLI default model.',
      missingTarget: true,
    });
    expect(describeScheduledExecution(loop, 'codex', 'sonnet', {})).toEqual({
      summary: 'Existing thread · Claude · sonnet',
      detail: 'Resumes the target thread using its persisted Claude harness and the current global sonnet model.',
      missingTarget: false,
    });
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

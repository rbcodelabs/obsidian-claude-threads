import { describe, it, expect } from 'vitest';
import {
  isThreadIdleForArchive,
  selectIdleThreadsForArchive,
  type IdleArchiveCandidate,
} from '../../src/autoArchive';

const NOW = 1_700_000_000_000; // fixed "now" so tests never read the wall clock
const DAY = 86_400_000;

/** Build a candidate thread, defaulting to a plain idle `waiting` thread. */
function thread(overrides: Partial<IdleArchiveCandidate> = {}): IdleArchiveCandidate {
  return {
    id: 'thread-1',
    status: 'waiting',
    updatedAt: NOW - 30 * DAY, // idle for 30 days by default
    ...overrides,
  };
}

describe('isThreadIdleForArchive', () => {
  const opts = { autoArchiveIdleDays: 14, now: NOW };

  it('selects a waiting thread idle longer than the threshold', () => {
    expect(isThreadIdleForArchive(thread({ updatedAt: NOW - 15 * DAY }), opts)).toBe(true);
  });

  it('does NOT select a waiting thread idle less than the threshold', () => {
    expect(isThreadIdleForArchive(thread({ updatedAt: NOW - 13 * DAY }), opts)).toBe(false);
  });

  it('does NOT select a thread exactly at the threshold (strictly greater-than)', () => {
    expect(isThreadIdleForArchive(thread({ updatedAt: NOW - 14 * DAY }), opts)).toBe(false);
  });

  it('does NOT select an active thread even if very old', () => {
    expect(isThreadIdleForArchive(thread({ status: 'active', updatedAt: NOW - 99 * DAY }), opts)).toBe(false);
  });

  it('does NOT select a reconnecting thread', () => {
    expect(isThreadIdleForArchive(thread({ status: 'reconnecting' }), opts)).toBe(false);
  });

  it('does NOT select an error thread', () => {
    expect(isThreadIdleForArchive(thread({ status: 'error' }), opts)).toBe(false);
  });

  it('does NOT select an already-archived thread', () => {
    expect(isThreadIdleForArchive(thread({ status: 'archived' }), opts)).toBe(false);
  });

  it('does NOT select the orchestrator thread', () => {
    const orch = thread({ id: 'orch' });
    expect(isThreadIdleForArchive(orch, { ...opts, orchestratorThreadId: 'orch' })).toBe(false);
  });

  it('does not select any referenced project orchestrator', () => {
    const orch = thread({ id: 'project-orch', updatedAt: NOW - 30 * DAY });
    expect(isThreadIdleForArchive(orch, { ...opts, orchestratorThreadIds: ['portfolio', 'project-orch'] })).toBe(false);
  });

  it('does NOT select a thread with a pending plan', () => {
    expect(isThreadIdleForArchive(thread({ pendingPlan: 'do the thing' }), opts)).toBe(false);
  });

  it('does NOT select a thread with pending questions', () => {
    const q = [{ question: 'ok?', header: 'h', options: [], multiSelect: false }];
    expect(isThreadIdleForArchive(thread({ pendingQuestions: q }), opts)).toBe(false);
  });

  it('selects a thread whose pendingQuestions array is empty', () => {
    expect(isThreadIdleForArchive(thread({ pendingQuestions: [] }), opts)).toBe(true);
  });

  it('selects nothing when the threshold is 0 (disabled)', () => {
    expect(isThreadIdleForArchive(thread(), { autoArchiveIdleDays: 0, now: NOW })).toBe(false);
  });

  it('selects nothing when the threshold is negative', () => {
    expect(isThreadIdleForArchive(thread(), { autoArchiveIdleDays: -5, now: NOW })).toBe(false);
  });
});

describe('selectIdleThreadsForArchive', () => {
  it('returns only the eligible waiting threads and excludes everyone else', () => {
    const threads: IdleArchiveCandidate[] = [
      thread({ id: 'idle-waiting', updatedAt: NOW - 30 * DAY }), // eligible
      thread({ id: 'fresh-waiting', updatedAt: NOW - 1 * DAY }), // too recent
      thread({ id: 'active', status: 'active', updatedAt: NOW - 30 * DAY }), // active
      thread({ id: 'error', status: 'error', updatedAt: NOW - 30 * DAY }), // error
      thread({ id: 'orch', updatedAt: NOW - 30 * DAY }), // orchestrator
      thread({ id: 'has-plan', updatedAt: NOW - 30 * DAY, pendingPlan: 'p' }), // pending plan
    ];

    const selected = selectIdleThreadsForArchive(threads, {
      autoArchiveIdleDays: 14,
      now: NOW,
      orchestratorThreadId: 'orch',
    });

    expect(selected.map((t) => t.id)).toEqual(['idle-waiting']);
  });

  it('returns an empty array when disabled (0), regardless of thread ages', () => {
    const threads = [thread({ updatedAt: NOW - 99 * DAY })];
    expect(selectIdleThreadsForArchive(threads, { autoArchiveIdleDays: 0, now: NOW })).toEqual([]);
  });

  it('returns an empty array when there are no threads', () => {
    expect(selectIdleThreadsForArchive([], { autoArchiveIdleDays: 14, now: NOW })).toEqual([]);
  });
});

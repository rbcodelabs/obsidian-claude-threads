import type { ScheduledItem } from './types';

export interface ScheduledWorkGroups {
  nextUp: ScheduledItem[];
  recurring: ScheduledItem[];
  threadSpecific: ScheduledItem[];
}

export interface NextOccurrenceDisplay {
  label: 'Next run' | 'Next check';
  relative: string;
  exact: string;
  overdue: boolean;
}

/** Builds the dashboard's user-visible groups without exposing system heartbeats. */
export function classifyScheduledItems(items: ScheduledItem[]): ScheduledWorkGroups {
  const visible = items.filter((item) => !item.isOrchestratorHeartbeat);
  const nextUp = visible
    .filter((item) => item.enabled && Number.isFinite(item.nextRun))
    .sort((a, b) => (a.nextRun ?? Number.POSITIVE_INFINITY) - (b.nextRun ?? Number.POSITIVE_INFINITY));

  return {
    nextUp,
    recurring: visible.filter((item) => !item.targetThreadId && item.origin !== 'wakeup'),
    threadSpecific: visible.filter((item) => !!item.targetThreadId || item.origin === 'wakeup'),
  };
}

export function formatRelativeTime(targetMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1_000));
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}

export function formatNextOccurrence(
  item: ScheduledItem,
  nowMs = Date.now(),
): NextOccurrenceDisplay | null {
  if (!item.enabled || !Number.isFinite(item.nextRun)) return null;
  const nextRun = item.nextRun as number;
  const overdue = nextRun <= nowMs;
  return {
    label: item.gate?.command ? 'Next check' : 'Next run',
    relative: overdue ? 'Overdue — catching up' : formatRelativeTime(nextRun, nowMs),
    exact: new Date(nextRun).toLocaleString(),
    overdue,
  };
}

import { formatWakeupCountdown } from './dashboardUtils';
import { formatLoopInterval } from './loopUtils';
import type { ScheduledItem } from './types';

export interface ScheduledActivity {
  id: string;
  kind: 'wakeup' | 'loop';
  nextRun: number;
  intervalSeconds?: number;
  label: string;
  item: ScheduledItem;
}

export function scheduledActivityForThread(items: ScheduledItem[], threadId: string | null): ScheduledActivity[] {
  if (!threadId) return [];
  return items
    .filter((item) => item.enabled && item.targetThreadId === threadId)
    .flatMap((item): ScheduledActivity[] => {
      if (item.origin === 'wakeup' && item.schedule.type === 'once') {
        const nextRun = item.nextRun ?? item.schedule.fireAt;
        if (nextRun == null) return [];
        return [{
          id: item.id,
          kind: 'wakeup',
          nextRun,
          label: item.name.replace(/^Wakeup:\s*/, '') || item.prompt,
          item,
        }];
      }
      if (item.schedule.type === 'interval' && item.schedule.intervalSeconds != null) {
        return [{
          id: item.id,
          kind: 'loop',
          nextRun: item.nextRun ?? Number.POSITIVE_INFINITY,
          intervalSeconds: item.schedule.intervalSeconds,
          label: item.prompt || item.name.replace(/^Loop:\s*/, ''),
          item,
        }];
      }
      return [];
    })
    .sort((a, b) => a.nextRun - b.nextRun);
}

export async function deleteScheduledActivity(
  activity: ScheduledActivity,
  deleteItem: (id: string) => Promise<unknown>,
  notifyWakeupChanged: (threadId: string) => void,
): Promise<void> {
  const targetThreadId = activity.item.targetThreadId;
  try {
    await deleteItem(activity.id);
  } finally {
    // Scheduler.deleteItem removes the item from its in-memory map before the
    // persistence write. Even if that write rejects, every live surface must
    // re-read the now-current memory state instead of remaining stale until an
    // unrelated event. The captured target also prevents navigation during the
    // await from notifying whichever thread happens to be active afterward.
    if (activity.kind === 'wakeup' && targetThreadId) notifyWakeupChanged(targetThreadId);
  }
}

export function scheduledActivitySummary(activity: ScheduledActivity[], now = Date.now()): string {
  const first = activity[0];
  if (!first) return '';
  const base = first.kind === 'wakeup'
    ? `Resumes ${formatWakeupCountdown(first.nextRun, now)}`
    : `Every ${formatLoopInterval(first.intervalSeconds ?? 0)}`;
  return activity.length > 1 ? `${base} · +${activity.length - 1}` : base;
}

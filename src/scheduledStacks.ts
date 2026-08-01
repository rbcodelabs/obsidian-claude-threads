/**
 * Shared grouping helper for collapsing repeat runs of the same scheduled
 * (cron) job into a single rollup unit, used by both the Kanban board and the
 * Agent Dashboard so a busy hourly job doesn't bury manually-created threads.
 */

import type { Thread } from './types';

export interface ScheduledStack {
  /** The `Thread.scheduledItemId` shared by every thread in this stack. */
  scheduledItemId: string;
  /** Display name for the job — the newest run's `scheduledItemName`, falling back to the id. */
  scheduledItemName: string;
  /** Threads in this stack, sorted newest-first. */
  threads: Thread[];
}

/**
 * Groups `threads` by `scheduledItemId`. A group only becomes a `ScheduledStack`
 * once it reaches `minCount` members — smaller groups (including every thread
 * with no `scheduledItemId` at all) fall through to `standalone`, unchanged
 * and in their original relative order, so callers can render them exactly as
 * they would any other thread.
 *
 * `minCount = 1` makes every distinct scheduled job its own stack (even a
 * lone quiet run) — used by the Agent Dashboard so the "Scheduled Jobs"
 * section doesn't pop in and out of existence as a job's single run comes and
 * goes. `minCount = 2` (the default) only stacks once repeats have actually
 * piled up — used by the Kanban board's quiet columns.
 */
export function partitionScheduledStacks(
  threads: Thread[],
  minCount = 2,
): { stacks: ScheduledStack[]; standalone: Thread[] } {
  const groups = new Map<string, Thread[]>();
  const order: string[] = []; // first-seen order, for stable stack ordering

  for (const t of threads) {
    if (!t.scheduledItemId) continue;
    const bucket = groups.get(t.scheduledItemId);
    if (bucket) {
      bucket.push(t);
    } else {
      groups.set(t.scheduledItemId, [t]);
      order.push(t.scheduledItemId);
    }
  }

  const stacks: ScheduledStack[] = [];
  const stackedIds = new Set<string>();

  for (const scheduledItemId of order) {
    const group = groups.get(scheduledItemId)!;
    if (group.length < minCount) continue;

    const sorted = [...group].sort((a, b) => b.updatedAt - a.updatedAt);
    stacks.push({
      scheduledItemId,
      scheduledItemName: sorted[0].scheduledItemName ?? scheduledItemId,
      threads: sorted,
    });
    for (const t of group) stackedIds.add(t.id);
  }

  const standalone = threads.filter(t => !stackedIds.has(t.id));

  return { stacks, standalone };
}

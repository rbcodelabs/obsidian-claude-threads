import type { ScheduledItem, ScheduledItemSchedule } from './types';

/**
 * Fields that can be updated on a ScheduledItem. The `schedule` field accepts
 * partial overrides — only the provided sub-fields are merged into the existing
 * schedule (e.g. you can change `timeOfDay` without supplying `type`).
 */
export interface SchedulerItemPatch {
  name?: string;
  prompt?: string;
  enabled?: boolean;
  schedule?: Partial<ScheduledItemSchedule>;
  cwd?: string;
  projectId?: string;
  lastRun?: number;
  nextRun?: number;
  lastThreadId?: string;
}

export interface SchedulerOptions {
  getItems: () => ScheduledItem[];
  saveItem: (item: ScheduledItem) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  createThread: (title: string, cwd: string, projectId?: string) => { id: string };
  sendMessage: (threadId: string, prompt: string) => Promise<void>;
  getDefaultCwd: () => string;
  /**
   * Returns true when a thread with the given ID still exists. Used by items
   * with a targetThreadId (loops) to decide whether to reuse the thread or
   * fall back to creating a new one. Optional for backwards compatibility.
   */
  threadExists?: (threadId: string) => boolean;
}

export class Scheduler {
  private timers = new Map<string, number>();
  private items: ScheduledItem[] = [];

  constructor(private options: SchedulerOptions) {}

  /** Load items from settings and arm timers. Call once on plugin load. */
  start(items: ScheduledItem[]): void {
    // Take an internal copy — do not mutate the passed-in array reference
    this.items = items.map((i) => ({ ...i }));
    for (const item of this.items) {
      if (item.enabled) {
        this.armTimer(item);
      }
    }
  }

  /** Stop all timers (call on plugin unload). */
  destroy(): void {
    for (const id of this.timers.values()) {
      window.clearTimeout(id);
    }
    this.timers.clear();
  }

  // Internal: compute next fire time from an item.
  // fromNow=true resets the base to Date.now() (used after a fired run).
  private computeNextRun(item: ScheduledItem, fromNow = false): number {
    const now = Date.now();
    const { schedule } = item;

    if (schedule.type === 'interval') {
      const intervalMs = (schedule.intervalSeconds ?? 3600) * 1000;
      if (fromNow || !item.lastRun) {
        return now + intervalMs;
      }
      return item.lastRun + intervalMs;
    }

    if (schedule.type === 'daily') {
      return this.nextTimeOfDay(schedule.timeOfDay ?? '09:00', now);
    }

    if (schedule.type === 'weekly') {
      return this.nextWeeklyRun(
        schedule.timeOfDay ?? '09:00',
        schedule.daysOfWeek ?? [1],
        now,
      );
    }

    return now + 86400 * 1000;
  }

  // Returns the next epoch ms for a given HH:MM time today or tomorrow.
  private nextTimeOfDay(timeOfDay: string, fromMs: number): number {
    const [hStr, mStr] = timeOfDay.split(':');
    const h = parseInt(hStr ?? '9', 10);
    const m = parseInt(mStr ?? '0', 10);

    const d = new Date(fromMs);
    const candidate = new Date(d);
    candidate.setHours(h, m, 0, 0);

    // If the time today has already passed, schedule for tomorrow
    if (candidate.getTime() <= fromMs) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.getTime();
  }

  // Returns the next epoch ms for weekly schedule.
  private nextWeeklyRun(timeOfDay: string, daysOfWeek: number[], fromMs: number): number {
    const [hStr, mStr] = timeOfDay.split(':');
    const h = parseInt(hStr ?? '9', 10);
    const m = parseInt(mStr ?? '0', 10);

    let best = Infinity;

    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(fromMs);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(h, m, 0, 0);

      const dayOfWeek = candidate.getDay();
      if (!daysOfWeek.includes(dayOfWeek)) continue;
      if (candidate.getTime() <= fromMs) continue;

      if (candidate.getTime() < best) {
        best = candidate.getTime();
      }
    }

    // Fallback: 7 days from now if nothing matched (should not happen with valid config)
    return best === Infinity ? fromMs + 7 * 86400 * 1000 : best;
  }

  // Internal: arm a setTimeout for an item, handling missed runs.
  private armTimer(item: ScheduledItem): void {
    // Cancel any existing timer for this item
    const existing = this.timers.get(item.id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      this.timers.delete(item.id);
    }

    if (!item.enabled) return;

    const now = Date.now();
    let delayMs: number;

    // Missed run detection: if nextRun is in the past, fire after a short delay
    if (item.nextRun && item.nextRun < now) {
      delayMs = 5_000; // 5-second delay to allow full plugin initialization
    } else if (item.nextRun && item.nextRun >= now) {
      delayMs = item.nextRun - now;
    } else {
      // No nextRun set yet — compute from scratch
      const next = this.computeNextRun(item);
      item.nextRun = next;
      this.options.saveItem({ ...item }).catch(console.error);
      delayMs = next - now;
    }

    const id = window.setTimeout(() => {
      this.fire(item).catch(console.error);
    }, delayMs) as unknown as number;

    this.timers.set(item.id, id);
  }

  // Internal: fire a scheduled item — create thread, update timestamps, rearm.
  private async fire(item: ScheduledItem): Promise<void> {
    this.timers.delete(item.id);

    // Re-fetch the current item state in case it was updated while the timer was pending
    const current = this.items.find((i) => i.id === item.id);
    if (!current || !current.enabled) return;

    try {
      // Loop items target an existing thread; fall back to a new thread if it's gone.
      const reuseTarget =
        current.targetThreadId &&
        (this.options.threadExists?.(current.targetThreadId) ?? false)
          ? current.targetThreadId
          : undefined;
      if (reuseTarget) {
        await this.options.sendMessage(reuseTarget, current.prompt);
        current.lastThreadId = reuseTarget;
      } else {
        const cwd = current.cwd || this.options.getDefaultCwd();
        const thread = this.options.createThread(current.name, cwd, current.projectId);
        await this.options.sendMessage(thread.id, current.prompt);
        current.lastThreadId = thread.id;
      }
    } catch (err) {
      console.error(`[Scheduler] Failed to fire scheduled item "${current.name}" (${current.id}):`, err);
    }

    current.lastRun = Date.now();
    current.nextRun = this.computeNextRun(current, true);

    this.options.saveItem({ ...current }).catch(console.error);

    // Rearm for the next run
    this.armTimer(current);
  }

  // CRUD used by the Cron tools

  createItem(params: Omit<ScheduledItem, 'id' | 'lastRun' | 'nextRun'>): ScheduledItem {
    const item: ScheduledItem = {
      ...params,
      id: crypto.randomUUID(),
    };

    // Compute the initial nextRun
    item.nextRun = this.computeNextRun(item);

    this.items.push(item);
    this.options.saveItem({ ...item }).catch(console.error);

    if (item.enabled) {
      this.armTimer(item);
    }

    return { ...item };
  }

  updateItem(id: string, patch: SchedulerItemPatch): ScheduledItem {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) {
      throw new Error(`Scheduled item not found: ${id}`);
    }

    const existing = this.items[idx];

    // Merge schedule sub-fields so callers can change just timeOfDay without
    // supplying the full ScheduledItemSchedule object.
    const mergedSchedule: ScheduledItemSchedule = patch.schedule
      ? { ...existing.schedule, ...patch.schedule }
      : existing.schedule;

    const { schedule: _schedulePatch, ...restPatch } = patch;
    const updated: ScheduledItem = { ...existing, ...restPatch, schedule: mergedSchedule };

    // If schedule or enabled changed, recompute nextRun
    const scheduleChanged =
      patch.schedule !== undefined ||
      patch.enabled !== undefined;

    if (scheduleChanged) {
      updated.nextRun = this.computeNextRun(updated, true);
    }

    this.items[idx] = updated;
    this.options.saveItem({ ...updated }).catch(console.error);

    // Rearm (armTimer handles cancelling existing and skipping if disabled)
    this.armTimer(updated);

    return { ...updated };
  }

  deleteItem(id: string): void {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return;

    // Cancel timer
    const timerId = this.timers.get(id);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      this.timers.delete(id);
    }

    this.items.splice(idx, 1);
    this.options.removeItem(id).catch(console.error);
  }

  listItems(): ScheduledItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  getItem(id: string): ScheduledItem | undefined {
    const item = this.items.find((i) => i.id === id);
    return item ? { ...item } : undefined;
  }
}

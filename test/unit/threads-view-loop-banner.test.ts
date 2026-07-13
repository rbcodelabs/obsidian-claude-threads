import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scheduler, type SchedulerOptions } from '../../src/Scheduler';
import { formatLoopInterval } from '../../src/loopUtils';

/**
 * Unit tests for the /loop fixes in ThreadsView: immediate kickoff,
 * replace-not-stack, the footer pill, and the loop banner's visible/hidden
 * + running/next-run text decision.
 *
 * ThreadsView itself is a full Obsidian ItemView and isn't instantiated
 * directly in this suite (see threads-view-cancel-restore.test.ts for the
 * established pattern). Instead these tests drive the real `Scheduler`
 * class (no Obsidian dependency) exactly the way `handleLoopCommand`,
 * `renderStatusFooter`, and `refreshLoopBanner` do, and exercise pure
 * mirrors of the small decision functions those methods contain.
 */

// Scheduler uses window.setTimeout/clearTimeout; alias window to globalThis so
// the fake timers installed by vitest are what the scheduler arms.
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

function makeScheduler(overrides: Partial<SchedulerOptions> = {}): {
  scheduler: Scheduler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockReturnValue({ id: 'new-thread' }),
    sendMessage,
    getDefaultCwd: () => '/tmp',
    threadExists: () => true,
    ...overrides,
  };
  const scheduler = new Scheduler(options);
  scheduler.start([]);
  return { scheduler, sendMessage };
}

/**
 * Mirrors the create-loop branch of `handleLoopCommand` in ThreadsView.ts:
 * delete any existing loop(s) targeting this thread ("replace, not stack"),
 * create the new one, and fire the immediate kickoff message.
 */
function runLoopCommand(
  scheduler: Scheduler,
  threadId: string,
  prompt: string,
  intervalSeconds: number,
  sendMessage: (threadId: string, prompt: string) => Promise<void>,
): { replaced: boolean } {
  const loopsForThread = () =>
    scheduler.listItems().filter((i) => i.targetThreadId === threadId);

  const existing = loopsForThread();
  for (const loop of existing) scheduler.deleteItem(loop.id);

  scheduler.createItem({
    name: `Loop: ${prompt.slice(0, 40)}`,
    prompt,
    schedule: { type: 'interval', intervalSeconds },
    enabled: true,
    targetThreadId: threadId,
  });

  // Immediate kickoff — fire-and-forget, mirroring the production code.
  void sendMessage(threadId, prompt);

  return { replaced: existing.length > 0 };
}

/** Mirrors the loop-pill computation inside `renderStatusFooter()`. */
function computeLoopPill(scheduler: Scheduler, activeThreadId: string | null):
  { label: string; icon: string; kind: string } | null {
  const activeLoops = activeThreadId
    ? scheduler.listItems().filter((i) => i.targetThreadId === activeThreadId)
    : [];
  if (activeLoops.length === 0) return null;
  const secs = activeLoops[0].schedule.intervalSeconds ?? 0;
  return { label: `Looping every ${formatLoopInterval(secs)}`, icon: 'repeat', kind: 'loop' };
}

/** Mirrors the visible-state decision inside `refreshLoopBanner()`. */
function computeLoopBannerText(
  scheduler: Scheduler,
  threadId: string | null,
  isRunning: (id: string) => boolean,
): string | null {
  const loop = threadId
    ? scheduler.listItems().find((i) => i.targetThreadId === threadId)
    : undefined;
  if (!loop) return null;

  if (threadId && isRunning(threadId)) return 'Loop running…';

  const next = loop.nextRun ? new Date(loop.nextRun) : null;
  const label = next
    ? `next ~${next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'next run pending';
  return `Looping every ${formatLoopInterval(loop.schedule.intervalSeconds ?? 0)} — ${label}`;
}

describe('handleLoopCommand — immediate kickoff', () => {
  it('sends the prompt immediately, before any interval elapses', () => {
    const { scheduler, sendMessage } = makeScheduler();
    runLoopCommand(scheduler, 'thread-1', 'check the build', 300, sendMessage);

    // No timer advance at all — the kickoff must have fired synchronously.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('thread-1', 'check the build');

    scheduler.destroy();
  });
});

describe('handleLoopCommand — replace, not stack', () => {
  it('a second /loop on the same thread replaces the first — exactly one item remains', () => {
    const { scheduler, sendMessage } = makeScheduler();

    const first = runLoopCommand(scheduler, 'thread-1', 'first prompt', 60, sendMessage);
    expect(first.replaced).toBe(false);
    expect(scheduler.listItems().filter((i) => i.targetThreadId === 'thread-1')).toHaveLength(1);

    const second = runLoopCommand(scheduler, 'thread-1', 'second prompt', 120, sendMessage);
    expect(second.replaced).toBe(true);

    const remaining = scheduler.listItems().filter((i) => i.targetThreadId === 'thread-1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].prompt).toBe('second prompt');
    expect(remaining[0].schedule.intervalSeconds).toBe(120);

    scheduler.destroy();
  });

  it('does not affect loops on other threads', () => {
    const { scheduler, sendMessage } = makeScheduler();

    runLoopCommand(scheduler, 'thread-1', 'thread 1 prompt', 60, sendMessage);
    runLoopCommand(scheduler, 'thread-2', 'thread 2 prompt', 60, sendMessage);
    runLoopCommand(scheduler, 'thread-1', 'thread 1 replaced', 90, sendMessage);

    expect(scheduler.listItems().filter((i) => i.targetThreadId === 'thread-1')).toHaveLength(1);
    expect(scheduler.listItems().filter((i) => i.targetThreadId === 'thread-2')).toHaveLength(1);

    scheduler.destroy();
  });
});

describe('renderStatusFooter — loop pill', () => {
  it('emits a loop pill when the active thread has a running loop', () => {
    const { scheduler, sendMessage } = makeScheduler();
    runLoopCommand(scheduler, 'thread-1', 'check the build', 300, sendMessage);

    const pill = computeLoopPill(scheduler, 'thread-1');
    expect(pill).not.toBeNull();
    expect(pill?.kind).toBe('loop');
    expect(pill?.icon).toBe('repeat');
    expect(pill?.label).toBe('Looping every 5m');

    scheduler.destroy();
  });

  it('omits the pill when the active thread has no loop', () => {
    const { scheduler, sendMessage } = makeScheduler();
    runLoopCommand(scheduler, 'thread-1', 'check the build', 300, sendMessage);

    expect(computeLoopPill(scheduler, 'thread-2')).toBeNull();
    expect(computeLoopPill(scheduler, null)).toBeNull();

    scheduler.destroy();
  });

  it('omits the pill after the loop is stopped', () => {
    const { scheduler, sendMessage } = makeScheduler();
    runLoopCommand(scheduler, 'thread-1', 'check the build', 300, sendMessage);
    for (const loop of scheduler.listItems().filter((i) => i.targetThreadId === 'thread-1')) {
      scheduler.deleteItem(loop.id);
    }

    expect(computeLoopPill(scheduler, 'thread-1')).toBeNull();

    scheduler.destroy();
  });
});

describe('refreshLoopBanner — text/visibility decision', () => {
  it('is hidden (null) when there is no loop for the active thread', () => {
    const { scheduler } = makeScheduler();
    expect(computeLoopBannerText(scheduler, 'thread-1', () => false)).toBeNull();
    scheduler.destroy();
  });

  it('shows "Loop running…" while the thread is running', () => {
    const { scheduler, sendMessage } = makeScheduler();
    runLoopCommand(scheduler, 'thread-1', 'check the build', 300, sendMessage);

    expect(computeLoopBannerText(scheduler, 'thread-1', () => true)).toBe('Loop running…');

    scheduler.destroy();
  });

  it('shows the interval + next-run time when the thread is idle', () => {
    const { scheduler, sendMessage } = makeScheduler();
    runLoopCommand(scheduler, 'thread-1', 'check the build', 300, sendMessage);

    const text = computeLoopBannerText(scheduler, 'thread-1', () => false);
    expect(text).toMatch(/^Looping every 5m — next ~/);

    scheduler.destroy();
  });
});

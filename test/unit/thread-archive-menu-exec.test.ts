import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeArchivePlan,
  runArchiveAction,
  type ArchiveExecutorDeps,
  type ArchiveMenuAction,
  type ArchiveMenuDeps,
} from '../../src/threadArchiveMenu';
import type { Project, Thread } from '../../src/types';

/**
 * `executeArchivePlan` copies the persistence contract of main.ts's
 * `sweepIdleThreads`: `archiveThreadById` deliberately does NOT save, so the
 * loop must save exactly once at the end — never per thread, and never at all
 * when nothing was archived. A partial failure must not abort the batch.
 */

let errors: unknown[][];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDeps(archiveImpl?: (id: string) => Promise<void>) {
  const order: string[] = [];
  const archiveThread = vi.fn(async (id: string) => {
    order.push(`archive:${id}`);
    if (archiveImpl) await archiveImpl(id);
  });
  const cancelWakeups = vi.fn((id: string) => { order.push(`cancel:${id}`); });
  const saveSettings = vi.fn(async () => { order.push('save'); });
  const deps: ArchiveExecutorDeps = { archiveThread, cancelWakeups, saveSettings };
  return { deps, order, archiveThread, cancelWakeups, saveSettings };
}

describe('executeArchivePlan', () => {
  it('cancels a thread’s wake-ups immediately before archiving it', async () => {
    const { deps, order } = makeDeps();
    await executeArchivePlan(['a', 'b'], deps);
    // Interleaved per thread, not batched — a pending wake-up must never fire
    // between its own thread's archive and the end of the loop.
    expect(order).toEqual(['cancel:a', 'archive:a', 'cancel:b', 'archive:b', 'save']);
  });

  it('archives sequentially and saves settings exactly once for a 5-id batch', async () => {
    const { deps, archiveThread, saveSettings } = makeDeps();
    const result = await executeArchivePlan(['a', 'b', 'c', 'd', 'e'], deps);

    expect(result).toEqual({ archived: 5, failed: 0 });
    expect(archiveThread).toHaveBeenCalledTimes(5);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it('does not save at all when nothing was archived', async () => {
    const { deps, saveSettings } = makeDeps();
    const result = await executeArchivePlan([], deps);

    expect(result).toEqual({ archived: 0, failed: 0 });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('does not save when every archive failed', async () => {
    const { deps, saveSettings } = makeDeps(async () => { throw new Error('boom'); });
    const result = await executeArchivePlan(['a', 'b'], deps);

    expect(result).toEqual({ archived: 0, failed: 2 });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('logs a mid-loop rejection and still archives the remaining ids', async () => {
    const { deps, archiveThread, saveSettings } = makeDeps(async (id) => {
      if (id === 'b') throw new Error('vault write failed');
    });

    const result = await executeArchivePlan(['a', 'b', 'c'], deps);

    expect(result).toEqual({ archived: 2, failed: 1 });
    expect(archiveThread.mock.calls.map(c => c[0])).toEqual(['a', 'b', 'c']);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain('Archive failed for thread b');
  });

  it('runs the archives one at a time rather than in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { deps } = makeDeps(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;
    });

    await executeArchivePlan(['a', 'b', 'c'], deps);

    expect(maxInFlight).toBe(1);
  });
});

/**
 * The "at most one modal, ever" invariant, asserted where it can actually
 * break.
 *
 * `buildArchivePlan` returns `confirm: ArchiveConfirm | null` — a single object
 * *by type*, so a test over the plan can only ever check what the one spec
 * says, never how many times a dialog is shown. The count is a property of
 * `runArchiveAction`, and nothing else in the suite pins it: duplicating the
 * `await deps.confirm(...)` gate would show two sequential dialogs for every
 * confirmed archive and every other test would still pass.
 */

function menuThread(id: string, title = id): Thread {
  return { id, title } as unknown as Thread;
}

const GOLDEN_WEALTH: Project = { id: 'p2', name: 'Golden Wealth', orchestratorThreadId: 'orch-p2' } as unknown as Project;

function makeMenuDeps(options: { threads: Thread[]; running?: string[]; approve?: boolean }) {
  const running = new Set(options.running ?? []);
  const archived: string[] = [];
  const confirm = vi.fn(async () => options.approve ?? true);
  const notify = vi.fn();
  const deps: ArchiveMenuDeps = {
    getThreads: () => options.threads,
    isRunning: (id) => running.has(id),
    getProjects: () => [GOLDEN_WEALTH],
    getPortfolioOrchestratorThreadId: () => 'portfolio',
    archiveThread: async (id) => { archived.push(id); },
    cancelWakeups: () => {},
    saveSettings: async () => {},
    confirm,
    notify,
  };
  return { deps, archived, confirm, notify };
}

/** Bulk + running + orchestrator: three hazards that must fold into one dialog. */
const HAZARDOUS: Thread[] = [
  menuThread('t1'), menuThread('t2'), menuThread('t3'), menuThread('t4'),
  menuThread('orch-p2', 'Golden Wealth Orchestrator'),
];

const BULK_ACTION: ArchiveMenuAction = {
  title: 'Archive these 3 runs',
  icon: 'archive',
  scope: { kind: 'stack', scheduledItemId: 'nightly', threadIds: ['t1', 't2', 'orch-p2'] },
};

describe('runArchiveAction — at most one modal', () => {
  it('shows a single confirm for a bulk set that is also running and orchestrating', async () => {
    const { deps, archived, confirm } = makeMenuDeps({ threads: HAZARDOUS, running: ['t1'] });

    await runArchiveAction(BULK_ACTION, deps);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(archived).toEqual(['t1', 't2', 'orch-p2']);
  });

  it('shows no modal at all for one idle, non-orchestrator thread', async () => {
    const { deps, archived, confirm } = makeMenuDeps({ threads: HAZARDOUS });

    await runArchiveAction(
      { title: 'Archive thread', icon: 'archive', scope: { kind: 'thread', threadId: 't1' } },
      deps,
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(archived).toEqual(['t1']);
  });

  it('asks once and archives nothing when the single dialog is declined', async () => {
    const { deps, archived, confirm } = makeMenuDeps({ threads: HAZARDOUS, running: ['t1'], approve: false });

    await runArchiveAction(BULK_ACTION, deps);

    // A second gate would re-prompt after the first `false`; the early return
    // must happen on the first decline.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(archived).toEqual([]);
  });

  it('never reaches the dialog when the plan is blocked', async () => {
    const { deps, confirm, notify } = makeMenuDeps({ threads: [menuThread('only')] });

    await runArchiveAction(
      { title: 'Archive thread', icon: 'archive', scope: { kind: 'thread', threadId: 'only' } },
      deps,
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

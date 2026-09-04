import { describe, it, expect } from 'vitest';
import { buildArchivePlan, type ArchivePlanContext, type ArchivePlanThread } from '../../src/archivePlan';
import type { OrchestratorContext } from '../../src/orchestratorThreads';

/**
 * The archive guard sequence. The load-bearing rule is the last describe block:
 * a bulk set that ALSO contains a running thread AND an orchestrator must still
 * produce exactly ONE confirm spec. Stacking modals here would mean a user
 * clicking through three dialogs to clear one scheduled job.
 */

const ORCH: OrchestratorContext = {
  portfolioThreadId: 'portfolio',
  projects: [{ id: 'p2', name: 'Golden Wealth', orchestratorThreadId: 'orch-p2' }],
};

function ctx(opts: {
  threads: ArchivePlanThread[];
  running?: string[];
  orchestrator?: OrchestratorContext;
}): ArchivePlanContext {
  const running = new Set(opts.running ?? []);
  return {
    threads: opts.threads,
    isRunning: (id) => running.has(id),
    orchestrator: opts.orchestrator ?? { portfolioThreadId: undefined, projects: [] },
  };
}

/** Six plain threads — big enough that no single archive trips the last-thread rule. */
const SIX: ArchivePlanThread[] = Array.from({ length: 6 }, (_, i) => ({ id: `t${i + 1}`, title: `Thread ${i + 1}` }));

describe('buildArchivePlan — the common case', () => {
  it('asks for no confirmation when archiving one idle, non-orchestrator thread', () => {
    const plan = buildArchivePlan(['t1'], ctx({ threads: SIX }));
    expect(plan.blocked).toBe(false);
    expect(plan.confirm).toBeNull();
    expect(plan.ids).toEqual(['t1']);
  });
});

describe('buildArchivePlan — id hygiene', () => {
  it('drops ids that no longer resolve and reports them separately', () => {
    const plan = buildArchivePlan(['t1', 'ghost', 't2'], ctx({ threads: SIX }));
    expect(plan.ids).toEqual(['t1', 't2']);
    expect(plan.missingIds).toEqual(['ghost']);
  });

  it('blocks when every requested id is already archived', () => {
    const plan = buildArchivePlan(['ghost-a', 'ghost-b'], ctx({ threads: SIX }));
    expect(plan.blocked).toBe(true);
    expect(plan.blockedMessage).toBe('Those threads are already archived.');
    expect(plan.ids).toEqual([]);
    expect(plan.confirm).toBeNull();
  });

  it('de-duplicates repeated ids', () => {
    const plan = buildArchivePlan(['t1', 't1', 't2', 't1'], ctx({ threads: SIX }));
    expect(plan.ids).toEqual(['t1', 't2']);
  });

  it('preserves the requested order', () => {
    const plan = buildArchivePlan(['t4', 't1', 't3'], ctx({ threads: SIX }));
    expect(plan.ids).toEqual(['t4', 't1', 't3']);
  });
});

describe('buildArchivePlan — last-thread rule', () => {
  it('blocks archiving the only remaining thread', () => {
    const plan = buildArchivePlan(['t1'], ctx({ threads: [SIX[0]] }));
    expect(plan.blocked).toBe(true);
    expect(plan.blockedMessage).toBe("Can't archive the last remaining thread.");
  });

  it('blocks a bulk set that would empty the board', () => {
    const three = SIX.slice(0, 3);
    const plan = buildArchivePlan(three.map(t => t.id), ctx({ threads: three }));
    expect(plan.blocked).toBe(true);
    expect(plan.blockedMessage).toBe("Can't archive the last remaining thread.");
  });

  it('allows a bulk set that leaves at least one thread behind', () => {
    const three = SIX.slice(0, 3);
    const plan = buildArchivePlan(['t1', 't2'], ctx({ threads: three }));
    expect(plan.blocked).toBe(false);
    expect(plan.ids).toEqual(['t1', 't2']);
  });
});

describe('buildArchivePlan — single-thread confirmations', () => {
  it('confirms before stopping a running session, naming the thread', () => {
    const plan = buildArchivePlan(['t1'], ctx({ threads: SIX, running: ['t1'] }));
    expect(plan.runningIds).toEqual(['t1']);
    expect(plan.confirm).toEqual({
      message: '"Thread 1" is still running. Archiving it stops the session.',
      confirmLabel: 'Archive anyway',
    });
  });

  it('confirms before archiving the Portfolio orchestrator with the verbatim warning', () => {
    const threads = [...SIX, { id: 'portfolio', title: 'Portfolio Orchestrator' }];
    const plan = buildArchivePlan(['portfolio'], ctx({ threads, orchestrator: ORCH }));
    expect(plan.orchestrators).toEqual([{ id: 'portfolio', role: { kind: 'portfolio' } }]);
    expect(plan.confirm).toEqual({
      message: 'This is your Portfolio Orchestrator. Deleting it stops portfolio review until you run "Open Portfolio Orchestrator" again to create a new one.',
      confirmLabel: 'Archive anyway',
    });
  });

  it('confirms before archiving a Project orchestrator', () => {
    const threads = [...SIX, { id: 'orch-p2', title: 'Golden Wealth Orchestrator' }];
    const plan = buildArchivePlan(['orch-p2'], ctx({ threads, orchestrator: ORCH }));
    expect(plan.confirm?.message).toBe(
      'This is the Golden Wealth Project Orchestrator. Deleting it stops automatic Project review until it is recreated.',
    );
  });
});

describe('buildArchivePlan — bulk confirmations', () => {
  it('confirms the scope of a plain bulk archive with a non-destructive label', () => {
    const plan = buildArchivePlan(['t1', 't2', 't3'], ctx({ threads: SIX }));
    expect(plan.confirm).toEqual({ message: 'Archive 3 runs?', confirmLabel: 'Archive' });
  });

  it('adds a running sentence to the same modal rather than a second one', () => {
    const plan = buildArchivePlan(['t1', 't2', 't3'], ctx({ threads: SIX, running: ['t2', 't3'] }));
    expect(plan.confirm).toEqual({
      message: 'Archive 3 runs? 2 of them are still running. Archiving them stops those sessions.',
      confirmLabel: 'Archive anyway',
    });
  });

  it('uses singular wording when exactly one of a bulk set is running', () => {
    const plan = buildArchivePlan(['t1', 't2'], ctx({ threads: SIX, running: ['t2'] }));
    expect(plan.confirm?.message).toBe('Archive 2 runs? 1 of them is still running. Archiving it stops that session.');
  });
});

/**
 * Composition only. `confirm` is `ArchiveConfirm | null` — one object by type —
 * so nothing here can count dialogs; these assert that all three hazard
 * sentences land in the one spec. The dialog COUNT is pinned separately, on
 * `runArchiveAction`, in thread-archive-menu-exec.test.ts.
 */
describe('buildArchivePlan — one confirm spec carries every hazard', () => {
  it('folds bulk + running + orchestrator into a single confirm spec', () => {
    const threads = [...SIX, { id: 'orch-p2', title: 'Golden Wealth Orchestrator' }];
    const plan = buildArchivePlan(['t1', 't2', 'orch-p2'], ctx({
      threads,
      running: ['t1'],
      orchestrator: ORCH,
    }));

    // Three independent hazards, one spec — all three sentences must be in it.
    expect(plan.confirm).not.toBeNull();
    expect(plan.confirm).toEqual({
      message: [
        'Archive 3 runs?',
        '1 of them is still running. Archiving it stops that session.',
        'This is the Golden Wealth Project Orchestrator. Deleting it stops automatic Project review until it is recreated.',
      ].join(' '),
      confirmLabel: 'Archive anyway',
    });
    expect(plan.runningIds).toEqual(['t1']);
    expect(plan.orchestrators).toHaveLength(1);
  });

  it('folds a single running orchestrator into one modal too', () => {
    const threads = [...SIX, { id: 'portfolio', title: 'Portfolio Orchestrator' }];
    const plan = buildArchivePlan(['portfolio'], ctx({ threads, running: ['portfolio'], orchestrator: ORCH }));
    expect(plan.confirm?.message).toBe(
      '"Portfolio Orchestrator" is still running. Archiving it stops the session. '
      + 'This is your Portfolio Orchestrator. Deleting it stops portfolio review until you run "Open Portfolio Orchestrator" again to create a new one.',
    );
    expect(plan.confirm?.confirmLabel).toBe('Archive anyway');
  });
});

/**
 * agent-dashboard-archive-menu.test.ts
 * @vitest-environment jsdom
 *
 * Right-click → Archive on the Agents List. AgentDashboard is a full Obsidian
 * ItemView and is not constructible under vitest, so these call the real
 * prototype render methods against a stub receiver — the rows under test are
 * the actual shipped markup and the actual shipped listeners.
 */
import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Menu, Platform } from 'obsidian';
import { AgentDashboard } from '../../src/AgentDashboard';
import type { Thread } from '../../src/types';
import type { ScheduledStack } from '../../src/scheduledStacks';

type MenuMock = Menu & {
  titles(): string[];
  item(title: string): { clickHandler?: (evt?: unknown) => unknown } | undefined;
};

let opened: MenuMock[] = [];
const realShow = Menu.prototype.showAtMouseEvent;

beforeEach(() => {
  opened = [];
  Menu.prototype.showAtMouseEvent = function (this: MenuMock, evt: unknown) {
    opened.push(this);
    return realShow.call(this, evt);
  } as typeof Menu.prototype.showAtMouseEvent;
});

afterEach(() => {
  Menu.prototype.showAtMouseEvent = realShow;
  Platform.isMobile = false;
});

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return { id, title: id, messages: [{ role: 'assistant', content: 'done' }], updatedAt: 1, reviewed: true, ...extra } as unknown as Thread;
}

function makeView(threads: Thread[]) {
  const archived: string[] = [];
  // Second argument recorded separately: `onlyIfHasMessages` is what stops a
  // bulk archive of 14 quiet cron runs from writing 14 empty vault notes, which
  // is the whole justification for the bulk items. A stub that swallowed it
  // would let the adapter drop the flag silently.
  const archiveCalls: Array<[string, boolean | undefined]> = [];
  const cancelled: string[] = [];
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const manager = {
    getThreads: () => threads,
    isRunning: () => false,
    isRunStale: () => false,
    hasPendingPermission: () => false,
    hasPendingQuestion: () => false,
    hasPendingPlan: () => false,
    getPendingPermission: () => null,
    getAgentRuns: () => [],
    getProjects: () => [],
    getProject: () => null,
    getThreadActivity: () => '',
    vaultRoot: '/vault',
  };
  const view = Object.assign(Object.create(AgentDashboard.prototype), {
    app: {},
    activeThreadId: null,
    manager,
    plugin: {
      manager,
      settings: { orchestratorThreadId: undefined },
      saveSettings,
      hasPendingWakeup: () => false,
      getPendingWakeups: () => [],
      archiveThreadById: async (id: string, onlyIfHasMessages?: boolean) => {
        archived.push(id);
        archiveCalls.push([id, onlyIfHasMessages]);
      },
      cancelWakeups: (id: string) => { cancelled.push(id); },
    },
    activityEls: new Map(),
    timeEls: new Map(),
    rowEls: new Map(),
    archiveDeps: null,
    expandedScheduledStacks: new Set<string>(),
    scheduleRender: vi.fn(),
    markReviewed: vi.fn(),
  }) as AgentDashboard;

  return { view, archived, archiveCalls, cancelled, saveSettings };
}

const proto = AgentDashboard.prototype as unknown as {
  renderRow(this: AgentDashboard, thread: Thread, state: string, parent: HTMLElement): void;
  renderScheduledJobRow(this: AgentDashboard, stack: ScheduledStack, parent: HTMLElement, scopeKey?: string): void;
};

function rightClick(el: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

const THREE = [thread('t1'), thread('t2'), thread('t3')];

describe('Agents List — right-click a thread row', () => {
  it('opens exactly one menu offering Archive thread, and suppresses the native menu', () => {
    const { view } = makeView(THREE);
    const host = document.createElement('div');
    proto.renderRow.call(view, THREE[0], 'idle', host);

    const event = rightClick(host.querySelector('.ct-agents-row')!);

    expect(opened).toHaveLength(1);
    expect(opened[0].titles()).toEqual(['Archive thread']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('archives that thread, cancelling its wake-ups first and saving once', async () => {
    const ctx = makeView(THREE);
    const host = document.createElement('div');
    proto.renderRow.call(ctx.view, THREE[0], 'idle', host);
    rightClick(host.querySelector('.ct-agents-row')!);

    await opened[0].item('Archive thread')!.clickHandler!();

    expect(ctx.cancelled).toEqual(['t1']);
    expect(ctx.archived).toEqual(['t1']);
    // `true` = onlyIfHasMessages: skip the vault note for a thread that never
    // said anything. Dropping it is a silent behaviour change, so pin the arg.
    expect(ctx.archiveCalls).toEqual([['t1', true]]);
    expect(ctx.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('leaves the native context menu alone on mobile', () => {
    Platform.isMobile = true;
    const { view } = makeView(THREE);
    const host = document.createElement('div');
    proto.renderRow.call(view, THREE[0], 'idle', host);

    const event = rightClick(host.querySelector('.ct-agents-row')!);

    expect(opened).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('falls through without preventing default when the row’s thread is already gone', () => {
    const { view } = makeView(THREE);
    const host = document.createElement('div');
    proto.renderRow.call(view, thread('ghost'), 'idle', host);

    const event = rightClick(host.querySelector('.ct-agents-row')!);

    expect(opened).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('Agents List — right-click a scheduled-job rollup', () => {
  const RUNS = [
    thread('r1', { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep' }),
    thread('r2', { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep' }),
    thread('manual'),
  ];
  const STACK: ScheduledStack = { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep', threads: [RUNS[0], RUNS[1]] };

  it('offers just the rollup item when it already covers every run of the job', () => {
    const { view } = makeView(RUNS);
    const host = document.createElement('div');
    proto.renderScheduledJobRow.call(view, STACK, host);

    rightClick(host.querySelector('.ct-agents-row-scheduled-stack')!);

    expect(opened).toHaveLength(1);
    expect(opened[0].titles()).toEqual(['Archive these 2 runs']);
  });

  it('offers the job-wide item when the job has runs in another status group', () => {
    const extra = [...RUNS, thread('r3', { scheduledItemId: 'nightly', scheduledItemName: 'Nightly sweep' })];
    const { view } = makeView(extra);
    const host = document.createElement('div');
    proto.renderScheduledJobRow.call(view, STACK, host);

    rightClick(host.querySelector('.ct-agents-row-scheduled-stack')!);

    expect(opened[0].titles()).toEqual(['Archive these 2 runs', 'Archive all 3 runs of this job']);
  });

  it('bulk-archives every run in the rollup with a single settings save', async () => {
    const ctx = makeView(RUNS);
    const host = document.createElement('div');
    proto.renderScheduledJobRow.call(ctx.view, STACK, host);
    rightClick(host.querySelector('.ct-agents-row-scheduled-stack')!);

    // Two runs is a bulk archive, so it asks first — approve it.
    const deps = (ctx.view as unknown as { archiveDeps: { confirm: unknown } }).archiveDeps;
    deps.confirm = vi.fn().mockResolvedValue(true);

    await opened[0].item('Archive these 2 runs')!.clickHandler!();

    expect(deps.confirm).toHaveBeenCalledWith({ message: 'Archive 2 runs?', confirmLabel: 'Archive' });
    // Call COUNT, not just the arguments: "at most one modal, ever" is the
    // invariant runArchiveAction promises, and only a count can catch a second
    // confirm gate being added ahead of the archive loop.
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.archived).toEqual(['r1', 'r2']);
    expect(ctx.archiveCalls).toEqual([['r1', true], ['r2', true]]);
    expect(ctx.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('archives nothing when the bulk confirmation is declined', async () => {
    const ctx = makeView(RUNS);
    const host = document.createElement('div');
    proto.renderScheduledJobRow.call(ctx.view, STACK, host);
    rightClick(host.querySelector('.ct-agents-row-scheduled-stack')!);

    const deps = (ctx.view as unknown as { archiveDeps: { confirm: unknown } }).archiveDeps;
    deps.confirm = vi.fn().mockResolvedValue(false);

    await opened[0].item('Archive these 2 runs')!.clickHandler!();

    expect(ctx.archived).toEqual([]);
    expect(ctx.saveSettings).not.toHaveBeenCalled();
  });

  it('opens exactly one menu for a nested row inside an expanded rollup', () => {
    const { view } = makeView(RUNS);
    (view as unknown as { expandedScheduledStacks: Set<string> }).expandedScheduledStacks.add(':nightly');
    const host = document.createElement('div');
    proto.renderScheduledJobRow.call(view, STACK, host);

    // The dashboard puts expanded children in a SIBLING div, not inside the
    // rollup row — so a nested right-click must never also open the rollup menu.
    const nested = host.querySelector('.ct-agents-stack-body .ct-agents-row')!;
    rightClick(nested);

    expect(opened).toHaveLength(1);
    expect(opened[0].titles()).toEqual(['Archive thread']);
  });
});

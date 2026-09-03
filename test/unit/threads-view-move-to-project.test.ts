import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Menu } from 'obsidian';
import { ThreadsView } from '../../src/ThreadsView';

/**
 * Covers the "Move to Project…" item added to the per-thread ⋯ menu.
 *
 * Before this, a thread created outside a Project could never be moved into one:
 * `threads_set_project` rejected it at the coordination layer and ThreadsView only
 * exposed a Project at thread *creation* time. This menu is the human-side escape hatch.
 *
 * ThreadsView is a full Obsidian ItemView and is not constructible under vitest, so these
 * call the real prototype methods against a stub receiver — the production code under
 * test is the actual shipped implementation, not a mirror.
 */

type MenuMock = Menu & { titles(): string[]; item(title: string): { checked: boolean; clickHandler?: (evt?: unknown) => unknown } | undefined };

/** Menus opened during a test, in creation order. */
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
});

interface Ctx {
  view: ThreadsView;
  setThreadProject: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  renderComposerContext: ReturnType<typeof vi.fn>;
}

function makeView(opts: {
  activeThreadId: string;
  threads: Array<{ id: string; projectId?: string }>;
  projects?: Array<{ id: string; name: string; orchestratorThreadId?: string }>;
  portfolioOrchestratorThreadId?: string;
  setThreadProjectImpl?: (...args: unknown[]) => void;
}): Ctx {
  const projects = opts.projects ?? [];
  const setThreadProject = vi.fn(opts.setThreadProjectImpl);
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const renderComposerContext = vi.fn();

  // Built on the real prototype so the methods under test call each other for real —
  // only collaborators and DOM-bound repaint helpers are stubbed.
  const view = Object.assign(Object.create(ThreadsView.prototype), {
    activeThreadId: opts.activeThreadId,
    compressedView: false,
    escalatedTurnModels: new Map(),
    manager: {
      getThread: (id: string) => opts.threads.find(t => t.id === id) ?? null,
      getProjects: () => projects,
      getProject: (id: string) => projects.find(p => p.id === id) ?? null,
      setThreadProject,
    },
    plugin: {
      settings: { orchestratorThreadId: opts.portfolioOrchestratorThreadId },
      discoveredModelsByHarness: { codex: [] },
      saveSettings,
    },
    renderComposerContext,
    // Referenced by the other ⋯ items; never invoked in these tests.
    toggleCompressView: vi.fn(),
    summarizeThread: vi.fn(),
    forkThread: vi.fn(),
  }) as ThreadsView;

  return { view, setThreadProject, saveSettings, renderComposerContext };
}

/** Private-by-convention methods; reached through the prototype for testing. */
const proto = ThreadsView.prototype as unknown as {
  toggleMoreMenu(this: ThreadsView, event: MouseEvent): void;
  openMoveToProjectMenu(this: ThreadsView, event: MouseEvent, threadId: string): void;
  moveThreadToProject(this: ThreadsView, threadId: string, projectId: string | null): Promise<void>;
};

const evt = {} as MouseEvent;
const PROJECTS = [
  { id: 'p1', name: 'Agentic PM Playbook' },
  { id: 'p2', name: 'Golden Wealth', orchestratorThreadId: 'orch-p2' },
];

describe('ThreadsView — Move to Project…', () => {
  it('offers the item for a normal unassigned thread', () => {
    const { view } = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    proto.toggleMoreMenu.call(view, evt);

    expect(opened).toHaveLength(1);
    expect(opened[0]!.titles()).toContain('Move to Project…');
  });

  it('offers the item for a thread that is a plain member of a Project', () => {
    const { view } = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1', projectId: 'p1' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    proto.toggleMoreMenu.call(view, evt);

    expect(opened[0]!.titles()).toContain('Move to Project…');
  });

  it('hides the item for the Portfolio orchestrator, which can never be assigned', () => {
    const { view } = makeView({
      activeThreadId: 'portfolio',
      threads: [{ id: 'portfolio' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    proto.toggleMoreMenu.call(view, evt);

    expect(opened[0]!.titles()).not.toContain('Move to Project…');
    // The rest of the ⋯ menu is untouched.
    expect(opened[0]!.titles()).toContain('Fork conversation');
  });

  it('hides the item for a Project orchestrator, which cannot be reassigned', () => {
    const { view } = makeView({
      activeThreadId: 'orch-p2',
      threads: [{ id: 'orch-p2', projectId: 'p2' }],
      projects: PROJECTS,
      portfolioOrchestratorThreadId: 'portfolio',
    });

    proto.toggleMoreMenu.call(view, evt);

    expect(opened[0]!.titles()).not.toContain('Move to Project…');
  });

  it('lists (No project) plus every Project, checking the thread’s current one', () => {
    const { view } = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1', projectId: 'p1' }],
      projects: PROJECTS,
    });

    proto.openMoveToProjectMenu.call(view, evt, 't1');

    const menu = opened[0]!;
    expect(menu.titles()).toEqual(['(No project)', 'Agentic PM Playbook', 'Golden Wealth']);
    expect(menu.item('Agentic PM Playbook')!.checked).toBe(true);
    expect(menu.item('(No project)')!.checked).toBe(false);
    expect(menu.item('Golden Wealth')!.checked).toBe(false);
  });

  it('checks (No project) when the thread has no Project', () => {
    const { view } = makeView({ activeThreadId: 't1', threads: [{ id: 't1' }], projects: PROJECTS });

    proto.openMoveToProjectMenu.call(view, evt, 't1');

    expect(opened[0]!.item('(No project)')!.checked).toBe(true);
  });

  it('selecting a Project calls setThreadProject with alignCwd true and persists', async () => {
    const ctx = makeView({ activeThreadId: 't1', threads: [{ id: 't1' }], projects: PROJECTS });

    proto.openMoveToProjectMenu.call(ctx.view, evt, 't1');
    await opened[0]!.item('Agentic PM Playbook')!.clickHandler!();

    expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', 'p1', true);
    expect(ctx.saveSettings).toHaveBeenCalled();
    expect(ctx.renderComposerContext).toHaveBeenCalledOnce();
  });

  it('selecting (No project) detaches by passing null', async () => {
    const ctx = makeView({ activeThreadId: 't1', threads: [{ id: 't1', projectId: 'p1' }], projects: PROJECTS });

    proto.openMoveToProjectMenu.call(ctx.view, evt, 't1');
    await opened[0]!.item('(No project)')!.clickHandler!();

    expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', null, true);
  });

  it('does not repaint the active-thread chrome when moving a non-active thread', async () => {
    const ctx = makeView({
      activeThreadId: 'other',
      threads: [{ id: 't1' }, { id: 'other' }],
      projects: PROJECTS,
    });

    await proto.moveThreadToProject.call(ctx.view, 't1', 'p1');

    expect(ctx.setThreadProject).toHaveBeenCalledWith('t1', 'p1', true);
    expect(ctx.renderComposerContext).not.toHaveBeenCalled();
  });

  it('surfaces a ThreadManager rejection instead of throwing out of the click handler', async () => {
    const ctx = makeView({
      activeThreadId: 't1',
      threads: [{ id: 't1' }],
      projects: PROJECTS,
      setThreadProjectImpl: () => { throw new Error('Project not found: p9'); },
    });

    await expect(proto.moveThreadToProject.call(ctx.view, 't1', 'p9')).resolves.toBeUndefined();
    expect(ctx.saveSettings).not.toHaveBeenCalled();
  });
});

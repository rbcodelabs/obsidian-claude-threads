/**
 * @vitest-environment jsdom
 *
 * Archiving is reachable from more places than `closeThread()`: the Agents List
 * and Kanban right-click menus, the MCP `archiveThread` handler, and the idle
 * sweep all land on `ThreadManager.deleteThread()` directly. Every one of them
 * emits `thread_deleted`, so ThreadsView repairs its selection from that event
 * rather than from any single call site.
 *
 * The failure this guards against is not cosmetic. `handleSendFromDispatch()`
 * only guards `if (!this.activeThreadId) return;` — a *stale* id passes that
 * check and reaches `ThreadManager.sendMessage()`, which throws
 * `Thread not found` while the dead conversation is still on screen.
 */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({
  formatToolName: (name: string) => name,
  getToolIcon: () => 'wrench',
}));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class {} }));
vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => false }));

import { ThreadsView } from '../../src/ThreadsView';
import type { ThreadEvent } from '../../src/ThreadManager';

type Probe = {
  handleThreadListEvent: (threadId: string, event: ThreadEvent) => void;
  activeThreadId: string | null;
  titleEl: unknown;
  manager: unknown;
  setActiveThread: (id: string) => Promise<void>;
  renderTitleBar: () => void;
  renderMessages: () => Promise<void>;
};

/**
 * Build a ThreadsView far enough to exercise the event handler, with the render
 * calls stubbed. `titleEl` is set because the handler treats a falsy one as
 * "buildUI hasn't run yet" and bails.
 */
function makeView(options: { active: string | null; remaining: string[] }) {
  const calls = { selected: [] as string[], titleBar: 0, messages: 0 };
  const view = new ThreadsView({} as never, { manager: {} } as never) as unknown as Probe;
  view.activeThreadId = options.active;
  view.titleEl = document.createElement('div');
  view.manager = { getThreads: () => options.remaining.map(id => ({ id })) };
  view.setActiveThread = async (id: string) => { calls.selected.push(id); };
  view.renderTitleBar = () => { calls.titleBar++; };
  view.renderMessages = async () => { calls.messages++; };
  return { view, calls };
}

const DELETED: ThreadEvent = { type: 'thread_deleted' };

describe('ThreadsView selection repair on thread_deleted', () => {
  it('re-selects a remaining thread when the open thread is archived', () => {
    const { view, calls } = makeView({ active: 'a', remaining: ['b', 'c'] });

    view.handleThreadListEvent('a', DELETED);

    expect(calls.selected).toEqual(['b']);
    // setActiveThread owns the assignment; the handler must not leave 'a' behind
    // for it to overwrite, nor null it out and strand the view.
    expect(view.activeThreadId).toBe('a');
  });

  it('clears the selection and re-renders when no threads remain', () => {
    const { view, calls } = makeView({ active: 'a', remaining: [] });

    view.handleThreadListEvent('a', DELETED);

    expect(view.activeThreadId).toBeNull();
    expect(calls.selected).toEqual([]);
    expect(calls.titleBar).toBe(1);
    expect(calls.messages).toBe(1);
  });

  it('leaves the selection alone when a different thread is archived', () => {
    const { view, calls } = makeView({ active: 'a', remaining: ['a', 'c'] });

    view.handleThreadListEvent('b', DELETED);

    expect(view.activeThreadId).toBe('a');
    expect(calls.selected).toEqual([]);
    // The switcher chrome still lists the archived thread, so it must refresh.
    expect(calls.titleBar).toBe(1);
  });

  it('does nothing before buildUI has run', () => {
    const { view, calls } = makeView({ active: 'a', remaining: [] });
    view.titleEl = null;

    view.handleThreadListEvent('a', DELETED);

    expect(view.activeThreadId).toBe('a');
    expect(calls.titleBar).toBe(0);
    expect(calls.messages).toBe(0);
  });

  it('ignores unrelated thread events', () => {
    const { view, calls } = makeView({ active: 'a', remaining: ['b'] });

    view.handleThreadListEvent('a', { type: 'done' });

    expect(view.activeThreadId).toBe('a');
    expect(calls.selected).toEqual([]);
    expect(calls.titleBar).toBe(0);
  });
});

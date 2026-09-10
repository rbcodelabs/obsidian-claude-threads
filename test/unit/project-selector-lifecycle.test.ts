/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (name: string) => name }));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class {} }));

import { AgentDashboard } from '../../src/AgentDashboard';
import { KanbanView } from '../../src/KanbanView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

type KanbanSelectorView = {
  projectSelectEl: HTMLSelectElement;
  selectedProjectId: string;
  handleEvent: (threadId: string, event: { type: 'projects_changed' }) => void;
  scheduleRender: () => void;
};

type DashboardSelectorView = {
  projectButtonEl: HTMLButtonElement;
  projectButtonNameEl: HTMLElement;
  selectedProjectId: string;
  handleEvent: (threadId: string, event: { type: 'projects_changed' }) => void;
  scheduleRender: () => void;
};

describe('Dashboard Project selector lifecycle', () => {
  it('adds and renames options, preserves a valid selection, and resets a deleted selection', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const first = manager.createProject('First', 'Projects/First');
    const plugin = { manager, settings: { ...DEFAULT_SETTINGS }, getActiveThreadId: () => null };
    const view = new AgentDashboard({} as never, plugin as never) as unknown as DashboardSelectorView;
    view.projectButtonEl = document.createElement('button');
    view.projectButtonNameEl = document.createElement('span');
    view.selectedProjectId = first.id;
    view.scheduleRender = vi.fn();

    view.handleEvent('', { type: 'projects_changed' });
    expect(view.projectButtonNameEl.textContent).toBe('First');
    expect(view.projectButtonEl.getAttribute('aria-label')).toBe('Dispatch Project: First');

    manager.updateProject(first.id, { name: 'Renamed' });
    view.handleEvent('', { type: 'projects_changed' });
    expect(view.projectButtonNameEl.textContent).toBe('Renamed');
    expect(view.selectedProjectId).toBe(first.id);

    manager.createProject('Second', 'Projects/Second');
    view.handleEvent('', { type: 'projects_changed' });
    expect(view.projectButtonNameEl.textContent).toBe('Renamed');

    manager.deleteProject(first.id);
    view.handleEvent('', { type: 'projects_changed' });
    expect(view.projectButtonNameEl.textContent).toBe('No Project');
    expect(view.projectButtonEl.getAttribute('aria-label')).toBe('Dispatch Project: No Project');
    expect(view.selectedProjectId).toBe('');
  });
});

describe('Kanban Project selector lifecycle', () => {
  it('adds and renames options, preserves a valid selection, and resets a deleted selection', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const first = manager.createProject('First', 'Projects/First');
    const plugin = { manager, settings: { ...DEFAULT_SETTINGS }, getActiveThreadId: () => null };
    const view = new KanbanView({} as never, plugin as never) as unknown as KanbanSelectorView;
    view.projectSelectEl = document.createElement('select');
    view.selectedProjectId = first.id;
    view.scheduleRender = vi.fn();

    view.handleEvent('', { type: 'projects_changed' });
    expect(view.projectSelectEl.value).toBe(first.id);

    manager.updateProject(first.id, { name: 'Renamed' });
    view.handleEvent('', { type: 'projects_changed' });
    expect(view.projectSelectEl.selectedOptions[0]?.textContent).toBe('Renamed');
    expect(view.projectSelectEl.value).toBe(first.id);

    const second = manager.createProject('Second', 'Projects/Second');
    view.handleEvent('', { type: 'projects_changed' });
    expect([...view.projectSelectEl.options].map((option) => option.value)).toContain(second.id);

    manager.deleteProject(first.id);
    view.handleEvent('', { type: 'projects_changed' });
    expect(view.projectSelectEl.value).toBe('');
    expect(view.selectedProjectId).toBe('');
  });
});

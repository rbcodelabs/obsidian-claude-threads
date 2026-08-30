/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (name: string) => name }));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class {} }));

import { AgentDashboard } from '../../src/AgentDashboard';
import { KanbanView } from '../../src/KanbanView';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

type SelectorView = {
  projectSelectEl: HTMLSelectElement;
  selectedProjectId: string;
  handleEvent: (threadId: string, event: { type: 'projects_changed' }) => void;
  scheduleRender: () => void;
};

describe.each([
  ['Dashboard', AgentDashboard],
  ['Kanban', KanbanView],
] as const)('%s Project selector lifecycle', (_name, View) => {
  it('adds and renames options, preserves a valid selection, and resets a deleted selection', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const first = manager.createProject('First', 'Projects/First');
    const plugin = { manager, settings: { ...DEFAULT_SETTINGS }, getActiveThreadId: () => null };
    const view = new View({} as never, plugin as never) as unknown as SelectorView;
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

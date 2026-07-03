import { describe, it, expect } from 'vitest';
import type { TaskItem } from '../../src/types';

/**
 * Mirrors the data-shaping logic from KanbanView.populateTaskSection().
 *
 * The real method is DOM-coupled (container.empty()/.createDiv()/.addClass(),
 * obsidian's setIcon) and only reachable via a fully-constructed KanbanView
 * (which itself needs a real plugin + ThreadManager + WorkspaceLeaf). Here we
 * extract the pure part — how the task list is bucketed into progress count,
 * visible rows, and the "+N more" overflow count — so it can be tested
 * without Obsidian or a DOM.
 *
 * If the implementation changes, update the function below to match.
 */
const MAX_TASKS = 5;

interface TaskSectionShape {
  hidden: boolean;
  completedCount: number;
  total: number;
  visibleTasks: TaskItem[];
  overflowCount: number; // 0 when tasks.length <= MAX_TASKS
}

function shapeTaskSection(tasks: TaskItem[] | undefined): TaskSectionShape {
  if (!tasks || tasks.length === 0) {
    return { hidden: true, completedCount: 0, total: 0, visibleTasks: [], overflowCount: 0 };
  }
  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const visibleTasks = tasks.slice(0, MAX_TASKS);
  const overflowCount = tasks.length > MAX_TASKS ? tasks.length - MAX_TASKS : 0;
  return { hidden: false, completedCount, total: tasks.length, visibleTasks, overflowCount };
}

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return { id: 't1', content: 'Do something', status: 'pending', ...overrides };
}

describe('kanban task section shaping', () => {
  it('hides the section when there are no tasks', () => {
    expect(shapeTaskSection(undefined)).toEqual({ hidden: true, completedCount: 0, total: 0, visibleTasks: [], overflowCount: 0 });
    expect(shapeTaskSection([])).toEqual({ hidden: true, completedCount: 0, total: 0, visibleTasks: [], overflowCount: 0 });
  });

  it('counts completed tasks against the total', () => {
    const tasks = [
      makeTask({ id: '1', status: 'completed' }),
      makeTask({ id: '2', status: 'completed' }),
      makeTask({ id: '3', status: 'in_progress' }),
      makeTask({ id: '4', status: 'pending' }),
    ];
    const shape = shapeTaskSection(tasks);
    expect(shape.hidden).toBe(false);
    expect(shape.completedCount).toBe(2);
    expect(shape.total).toBe(4);
    expect(shape.overflowCount).toBe(0);
    expect(shape.visibleTasks).toHaveLength(4);
  });

  it('truncates to MAX_TASKS and reports the overflow count', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => makeTask({ id: String(i), content: `Task ${i}` }));
    const shape = shapeTaskSection(tasks);
    expect(shape.visibleTasks).toHaveLength(MAX_TASKS);
    expect(shape.visibleTasks.map(t => t.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(shape.overflowCount).toBe(3);
  });

  it('does not report overflow when tasks.length exactly equals MAX_TASKS', () => {
    const tasks = Array.from({ length: MAX_TASKS }, (_, i) => makeTask({ id: String(i) }));
    const shape = shapeTaskSection(tasks);
    expect(shape.visibleTasks).toHaveLength(MAX_TASKS);
    expect(shape.overflowCount).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { Thread } from '../../src/types';
import type { TaskTrackerEvent } from '../../src/ClaudeSession';

function makeManager() {
  return new ThreadManager({ ...DEFAULT_SETTINGS });
}

function apply(manager: ThreadManager, thread: Thread, event: TaskTrackerEvent): void {
  (manager as unknown as { applyTaskEvent(t: Thread, e: TaskTrackerEvent): void }).applyTaskEvent(
    thread,
    event,
  );
}

describe('ThreadManager — task tracker (applyTaskEvent)', () => {
  it('replace populates the full list with sequential ids (TodoWrite)', () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    apply(manager, thread, {
      kind: 'replace',
      tasks: [
        { content: 'Write docs', status: 'completed' },
        { content: 'Ship release', status: 'in_progress' },
        { content: 'Announce', status: 'pending' },
      ],
    });
    expect(thread.tasks).toEqual([
      { id: '1', content: 'Write docs', status: 'completed' },
      { id: '2', content: 'Ship release', status: 'in_progress' },
      { id: '3', content: 'Announce', status: 'pending' },
    ]);
  });

  it('create appends a pending task with the CLI-assigned id (TaskCreate)', () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    apply(manager, thread, { kind: 'create', id: '1', content: 'Research docs' });
    apply(manager, thread, { kind: 'create', id: '2', content: 'Scaffold app' });
    expect(thread.tasks).toEqual([
      { id: '1', content: 'Research docs', status: 'pending' },
      { id: '2', content: 'Scaffold app', status: 'pending' },
    ]);
  });

  it('update transitions status by id (TaskUpdate)', () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    apply(manager, thread, { kind: 'create', id: '1', content: 'Research docs' });
    apply(manager, thread, { kind: 'update', id: '1', status: 'in_progress' });
    expect(thread.tasks![0].status).toBe('in_progress');
    apply(manager, thread, { kind: 'update', id: '1', status: 'completed' });
    expect(thread.tasks![0].status).toBe('completed');
  });

  it('update with status deleted removes the task', () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    apply(manager, thread, { kind: 'create', id: '1', content: 'A' });
    apply(manager, thread, { kind: 'create', id: '2', content: 'B' });
    apply(manager, thread, { kind: 'update', id: '1', status: 'deleted' });
    expect(thread.tasks).toEqual([{ id: '2', content: 'B', status: 'pending' }]);
  });

  it('update for an unknown id with content creates the task', () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    apply(manager, thread, { kind: 'update', id: '7', status: 'in_progress', content: 'Late join' });
    expect(thread.tasks).toEqual([{ id: '7', content: 'Late join', status: 'in_progress' }]);
  });

  it('update for an unknown id without content is a no-op', () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    apply(manager, thread, { kind: 'update', id: '7', status: 'completed' });
    expect(thread.tasks).toEqual([]);
  });

  it('duplicate create updates the subject instead of duplicating', () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    apply(manager, thread, { kind: 'create', id: '1', content: 'Old subject' });
    apply(manager, thread, { kind: 'create', id: '1', content: 'New subject' });
    expect(thread.tasks).toEqual([{ id: '1', content: 'New subject', status: 'pending' }]);
  });

  it('ignores unknown status strings on update', () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    apply(manager, thread, { kind: 'create', id: '1', content: 'A' });
    apply(manager, thread, { kind: 'update', id: '1', status: 'bogus' });
    expect(thread.tasks![0].status).toBe('pending');
  });
});

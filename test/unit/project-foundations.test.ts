import { describe, expect, it, vi } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { resolveProjectVaultRoot } from '../../src/projectPaths';

describe('ThreadManager project foundations', () => {
  it('derives Project vault folders from the adapter vault root, not defaultCwd', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, defaultCwd: '/repos/default' });
    manager.vaultRoot = resolveProjectVaultRoot({ getBasePath: () => '/vault' });
    const project = manager.createProject('Derived', 'Projects/Derived');

    expect(manager.getProjectCwd(project)).toBe('/vault/Projects/Derived');
  });

  it('emits lifecycle events when Projects are created, updated, and deleted', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const events: string[] = [];
    manager.subscribe((_id, event) => events.push(event.type));

    const project = manager.createProject('One', 'Projects/One');
    manager.updateProject(project.id, { name: 'Renamed' });
    manager.deleteProject(project.id);

    expect(events.filter((type) => type === 'projects_changed')).toHaveLength(3);
  });
  it('resolves a project cwd from the vault unless an override is set', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.vaultRoot = '/vault';
    const derived = manager.createProject('Derived', 'Projects/Derived');
    const overridden = manager.createProject('Repo', 'Projects/Repo', undefined, '/repos/repo');

    expect(manager.getProjectCwd(derived)).toBe('/vault/Projects/Derived');
    expect(manager.getProjectCwd(overridden)).toBe('/repos/repo');
  });

  it('rejects assignment to an unknown project without mutating the thread', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const thread = manager.createThread('Task', '/original');

    expect(() => manager.setThreadProject(thread.id, 'missing')).toThrow('Project not found: missing');
    expect(thread.projectId).toBeUndefined();
    expect(thread.cwd).toBe('/original');
  });

  it('associates a project without changing cwd or session by default', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const project = manager.createProject('Repo', 'Projects/Repo', undefined, '/repos/repo');
    const thread = manager.createThread('Task', '/original');
    thread.sessionId = 'session-1';

    const events: string[] = [];
    manager.subscribe((_id, event) => events.push(event.type));
    manager.setThreadProject(thread.id, project.id);

    expect(thread.projectId).toBe(project.id);
    expect(thread.cwd).toBe('/original');
    expect(thread.sessionId).toBe('session-1');
    expect(events).toContain('project_changed');
    expect(events).not.toContain('cwd_changed');
  });

  it('aligns cwd through the safe cwd-change path when requested', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const project = manager.createProject('Repo', 'Projects/Repo', undefined, '/repos/repo');
    const thread = manager.createThread('Task', '/original');
    thread.sessionId = 'session-1';
    const events: string[] = [];
    manager.subscribe((_id, event) => events.push(event.type));

    manager.setThreadProject(thread.id, project.id, true);

    expect(thread.projectId).toBe(project.id);
    expect(thread.cwd).toBe('/repos/repo');
    expect(thread.sessionId).toBeUndefined();
    expect(events).toContain('cwd_changed');
    expect(events.indexOf('project_changed')).toBeLessThan(events.indexOf('cwd_changed'));
  });

  it('clearing a project leaves cwd unchanged even when alignCwd is true', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const project = manager.createProject('Repo', 'Projects/Repo', undefined, '/repos/repo');
    const thread = manager.createThread('Task', '/worktree', project.id);

    manager.setThreadProject(thread.id, null, true);

    expect(thread.projectId).toBeUndefined();
    expect(thread.cwd).toBe('/worktree');
  });

  it('deleting a Project detaches an active member through project_changed', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const project = manager.createProject('Repo', 'Projects/Repo');
    const thread = manager.createThread('Task', '/current', project.id);
    const events: string[] = [];
    manager.subscribe((threadId, event) => {
      if (threadId === thread.id) events.push(event.type);
    });

    manager.deleteProject(project.id);

    expect(thread.projectId).toBeUndefined();
    expect(thread.cwd).toBe('/current');
    expect(events).toEqual(['project_changed']);
  });
});

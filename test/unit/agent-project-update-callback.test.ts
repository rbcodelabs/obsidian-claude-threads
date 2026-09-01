import { describe, expect, it, vi } from 'vitest';
import { createAgentProjectUpdateCallback } from '../../src/main';
import type { Project } from '../../src/types';

function fixture() {
  const project: Project = {
    id: 'project-1', name: 'Original', description: 'Old context', vaultFolder: 'Projects/One',
    cwdOverride: '/repos/old', createdAt: 1,
  };
  const updateProject = vi.fn((id: string, patch: Partial<Project>) => {
    if (id !== project.id) throw new Error(`Project not found: ${id}`);
    Object.assign(project, patch);
    return project;
  });
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const callback = createAgentProjectUpdateCallback({
    getProject: id => id === project.id ? project : undefined,
    updateProject,
    getProjectCwd: value => value.cwdOverride ?? `/vault/${value.vaultFolder}`,
    saveSettings,
  });
  return { project, updateProject, saveSettings, callback };
}

describe('createAgentProjectUpdateCallback', () => {
  it('awaits persistence and returns the complete post-update snapshot', async () => {
    const { callback, saveSettings } = fixture();
    let release!: () => void;
    saveSettings.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const pending = callback('project-1', { name: 'Renamed', cwdOverride: undefined }).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toEqual({
      id: 'project-1', name: 'Renamed', description: 'Old context', vaultFolder: 'Projects/One',
      cwdOverride: undefined, effectiveCwd: '/vault/Projects/One', orchestratorThreadId: undefined,
    });
  });

  it('restores the prior live Project state when persistence fails', async () => {
    const { callback, project, saveSettings } = fixture();
    saveSettings.mockRejectedValue(new Error('disk full'));
    await expect(callback('project-1', { name: 'Lost', description: undefined, cwdOverride: '/repos/new' })).rejects.toThrow('disk full');
    expect(project).toMatchObject({ name: 'Original', description: 'Old context', cwdOverride: '/repos/old' });
  });

  it('rejects unknown Projects before attempting persistence', async () => {
    const { callback, saveSettings } = fixture();
    await expect(callback('missing', { name: 'Nope' })).rejects.toThrow(/Project not found/);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: 'Original' }, 'name'],
    [{ description: 'Old context' }, 'description'],
    [{ cwdOverride: '/repos/old' }, 'cwdOverride'],
  ])('rejects unchanged %s without mutating or saving', async (patch) => {
    const { callback, updateProject, saveSettings } = fixture();
    await expect(callback('project-1', patch)).rejects.toThrow(/does not change/i);
    expect(updateProject).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it.each([{ description: undefined }, { cwdOverride: undefined }])('rejects clearing an already-cleared optional field: %o', async (patch) => {
    const { callback, project, updateProject, saveSettings } = fixture();
    Object.assign(project, patch);
    await expect(callback('project-1', patch)).rejects.toThrow(/does not change/i);
    expect(updateProject).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('serializes a second update after a failed first update and rollback', async () => {
    const { callback, project, saveSettings } = fixture();
    let rejectFirst!: (error: Error) => void;
    saveSettings
      .mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(undefined);

    const first = callback('project-1', { name: 'First' });
    const second = callback('project-1', { description: 'Second context' });
    await Promise.resolve();
    expect(project.name).toBe('First');
    expect(saveSettings).toHaveBeenCalledTimes(1);
    rejectFirst(new Error('disk full'));

    await expect(first).rejects.toThrow('disk full');
    await expect(second).resolves.toMatchObject({ name: 'Original', description: 'Second context' });
    expect(project).toMatchObject({ name: 'Original', description: 'Second context', cwdOverride: '/repos/old' });
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });

  it('serializes successful overlapping updates deterministically', async () => {
    const { callback, project, saveSettings } = fixture();
    let releaseFirst!: () => void;
    saveSettings
      .mockReturnValueOnce(new Promise<void>(resolve => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(undefined);

    const first = callback('project-1', { name: 'First' });
    const second = callback('project-1', { description: 'Second context' });
    await Promise.resolve();
    expect(project).toMatchObject({ name: 'First', description: 'Old context' });
    expect(saveSettings).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    await expect(second).resolves.toMatchObject({ name: 'First', description: 'Second context' });
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });

  it('preserves an unrelated Settings UI edit when the tool save fails', async () => {
    const { callback, project, saveSettings } = fixture();
    let rejectSave!: (error: Error) => void;
    saveSettings.mockReturnValue(new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    const pending = callback('project-1', { name: 'Tool name' });
    await Promise.resolve();
    project.description = 'UI context';
    rejectSave(new Error('disk full'));
    await expect(pending).rejects.toThrow('disk full');
    expect(project).toMatchObject({ name: 'Original', description: 'UI context', cwdOverride: '/repos/old' });
  });

  it('preserves a later same-field Settings UI edit when the tool save fails', async () => {
    const { callback, project, saveSettings } = fixture();
    let rejectSave!: (error: Error) => void;
    saveSettings.mockReturnValue(new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    const pending = callback('project-1', { name: 'Tool name' });
    await Promise.resolve();
    project.name = 'UI name';
    rejectSave(new Error('disk full'));
    await expect(pending).rejects.toThrow('disk full');
    expect(project).toMatchObject({ name: 'UI name', description: 'Old context', cwdOverride: '/repos/old' });
  });

  it('continues processing after queued no-op and unknown-project failures', async () => {
    const { callback, project, saveSettings } = fixture();
    const noOp = callback('project-1', { name: 'Original' });
    const unknown = callback('missing', { name: 'Missing' });
    const valid = callback('project-1', { name: 'Recovered' });
    await expect(noOp).rejects.toThrow(/does not change/i);
    await expect(unknown).rejects.toThrow(/Project not found/i);
    await expect(valid).resolves.toMatchObject({ name: 'Recovered' });
    expect(project.name).toBe('Recovered');
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it('serializes updates submitted by two consumers of the shared callback', async () => {
    const { callback, project, saveSettings } = fixture();
    const consumerA = callback;
    const consumerB = callback;
    let releaseFirst!: () => void;
    saveSettings.mockReturnValueOnce(new Promise<void>(resolve => { releaseFirst = resolve; })).mockResolvedValueOnce(undefined);
    const first = consumerA('project-1', { name: 'Consumer A' });
    const second = consumerB('project-1', { description: 'Consumer B' });
    await Promise.resolve();
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(project.description).toBe('Old context');
    releaseFirst();
    await first;
    await second;
    expect(project).toMatchObject({ name: 'Consumer A', description: 'Consumer B' });
  });
});

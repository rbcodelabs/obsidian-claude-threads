/**
 * delete-project-secret-scopes.test.ts
 *
 * Verifies that ClaudeThreadsPlugin.deleteProject() prunes the deleted
 * project's id out of every PluginSettings.secretEnvScopes list, dropping a
 * varName key entirely once its list becomes empty (reverting that secret to
 * global rather than leaving it scoped-to-nothing).
 *
 * Uses the same call-the-prototype-method-against-a-fake-plugin harness as
 * dispatch-project.test.ts, since instantiating the full plugin needs a live
 * Obsidian environment we don't have in unit tests.
 */

import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';

function pluginHarness(secretEnvScopes?: Record<string, string[]>) {
  const project = { id: 'proj-1', name: 'P1', vaultFolder: 'Projects/P1', createdAt: 1 };
  const manager = {
    getProject: vi.fn((id: string) => (id === project.id ? project : undefined)),
    getProjectCwd: vi.fn(() => '/repos/p1'),
    deleteProject: vi.fn(),
  };
  const scheduler = { detachProject: vi.fn().mockResolvedValue(undefined) };
  const settings: { secretEnvScopes?: Record<string, string[]> } = { secretEnvScopes };
  const plugin = {
    manager,
    scheduler,
    settings,
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  return { plugin, manager, scheduler, settings };
}

describe('deleteProject secret-scope pruning', () => {
  it('removes the deleted project id from every secretEnvScopes list', async () => {
    const { plugin, settings } = pluginHarness({
      FOO: ['proj-1', 'proj-2'],
      BAR: ['proj-1'],
      BAZ: ['proj-2'],
    });

    await ClaudeThreadsPlugin.prototype.deleteProject.call(plugin, 'proj-1');

    expect(settings.secretEnvScopes).toEqual({ FOO: ['proj-2'], BAZ: ['proj-2'] });
  });

  it('drops a varName key entirely once its list becomes empty', async () => {
    const { plugin, settings } = pluginHarness({ FOO: ['proj-1'] });

    await ClaudeThreadsPlugin.prototype.deleteProject.call(plugin, 'proj-1');

    expect(settings.secretEnvScopes).toEqual({});
  });

  it('persists the pruned scopes via saveSettings', async () => {
    const { plugin } = pluginHarness({ FOO: ['proj-1'] });

    await ClaudeThreadsPlugin.prototype.deleteProject.call(plugin, 'proj-1');

    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it('is a no-op on secretEnvScopes when it was never configured', async () => {
    const { plugin, settings } = pluginHarness(undefined);

    await ClaudeThreadsPlugin.prototype.deleteProject.call(plugin, 'proj-1');

    expect(settings.secretEnvScopes).toEqual({});
  });

  it('does nothing (including no prune) when the project does not exist', async () => {
    const { plugin, settings, manager } = pluginHarness({ FOO: ['proj-1', 'proj-9'] });

    await ClaudeThreadsPlugin.prototype.deleteProject.call(plugin, 'missing-project');

    expect(manager.deleteProject).not.toHaveBeenCalled();
    expect(settings.secretEnvScopes).toEqual({ FOO: ['proj-1', 'proj-9'] });
  });
});

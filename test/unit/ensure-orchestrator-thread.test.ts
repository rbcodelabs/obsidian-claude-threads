/**
 * ensure-orchestrator-thread.test.ts
 *
 * Regression coverage for ClaudeThreadsPlugin.ensureOrchestratorThread()'s
 * stale-heartbeat cleanup: when the previously-tracked orchestrator thread no
 * longer exists (deleted/archived out from under the correlation), a fresh
 * thread is created and any heartbeat ScheduledItems still targeting the
 * stale thread ID are removed via scheduler.deleteItem() so they don't keep
 * firing into a thread that's gone.
 *
 * Follows the same construction pattern as save-settings-race.test.ts:
 * a minimal ClaudeThreadsPlugin instance built via
 * Object.create(ClaudeThreadsPlugin.prototype), bypassing Obsidian's Plugin
 * constructor (no real App/manifest needed for this method).
 */

import { describe, it, expect, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type ScheduledItem } from '../../src/types';

function makePlugin() {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  plugin.manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  plugin.settings = { ...DEFAULT_SETTINGS, defaultCwd: '/tmp', scheduledItems: [] };
  (plugin as unknown as { saveData: (d: unknown) => Promise<void> }).saveData = vi.fn().mockResolvedValue(undefined);
  (plugin as unknown as { openThreadInChatView: (id: string) => Promise<void> }).openThreadInChatView =
    vi.fn().mockResolvedValue(undefined);

  const deleteItem = vi.fn().mockResolvedValue(undefined);
  const createItem = vi.fn().mockImplementation(async (item: ScheduledItem) => {
    plugin.settings.scheduledItems = [...(plugin.settings.scheduledItems ?? []), { ...item, id: item.id ?? crypto.randomUUID() }];
  });
  (plugin as unknown as { scheduler: { deleteItem: typeof deleteItem; createItem: typeof createItem } }).scheduler = {
    deleteItem,
    createItem,
  };

  return { plugin, deleteItem, createItem };
}

describe('ClaudeThreadsPlugin.ensureOrchestratorThread() — stale heartbeat cleanup', () => {
  it('keeps the live orchestrator, reference, and heartbeat when archive persistence fails', async () => {
    const { plugin, deleteItem } = makePlugin();
    const orchestrator = plugin.manager.createThread('Portfolio', '/tmp');
    plugin.settings.orchestratorThreadId = orchestrator.id;
    plugin.settings.saveThreadsToVault = true;
    plugin.settings.scheduledItems = [{
      id: 'heartbeat', name: 'Heartbeat', prompt: 'review', schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true, targetThreadId: orchestrator.id, isOrchestratorHeartbeat: true,
    }];
    plugin.persistence = { saveThread: vi.fn().mockRejectedValue(new Error('vault write failed')) } as never;

    await expect((plugin as unknown as { archiveThreadById: (id: string) => Promise<void> }).archiveThreadById(orchestrator.id)).rejects.toThrow('vault write failed');

    expect(plugin.manager.getThread(orchestrator.id)).toBe(orchestrator);
    expect(plugin.settings.orchestratorThreadId).toBe(orchestrator.id);
    expect(plugin.settings.scheduledItems).toHaveLength(1);
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('restores the live vault note when retirement fails after archive persistence', async () => {
    const { plugin, deleteItem } = makePlugin();
    const orchestrator = plugin.manager.createThread('Portfolio', '/tmp');
    orchestrator.status = 'waiting';
    plugin.settings.orchestratorThreadId = orchestrator.id;
    plugin.settings.saveThreadsToVault = true;
    plugin.settings.scheduledItems = [{
      id: 'heartbeat', name: 'Heartbeat', prompt: 'review', schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true, targetThreadId: orchestrator.id, isOrchestratorHeartbeat: true,
    }];
    const saveThread = vi.fn().mockResolvedValue(undefined);
    plugin.persistence = { saveThread } as never;
    deleteItem.mockRejectedValueOnce(new Error('heartbeat cleanup failed'));

    await expect(plugin.archiveThreadById(orchestrator.id)).rejects.toThrow('heartbeat cleanup failed');

    expect(saveThread).toHaveBeenCalledTimes(2);
    expect(saveThread.mock.calls[0]![0].status).toBe('archived');
    expect(saveThread.mock.calls[1]![0].status).toBe('waiting');
    expect(plugin.manager.getThread(orchestrator.id)).toBe(orchestrator);
    expect(plugin.settings.orchestratorThreadId).toBe(orchestrator.id);
    expect(plugin.settings.scheduledItems).toHaveLength(1);
  });


  it('retires portfolio and Project orchestrators by clearing refs and heartbeats first', async () => {
    const { plugin, deleteItem } = makePlugin();
    const portfolio = plugin.manager.createThread('Portfolio', '/tmp');
    plugin.settings.orchestratorThreadId = portfolio.id;
    const project = plugin.manager.createProject('HipTrip', 'HipTrip');
    const projectOrch = plugin.manager.createThread('HipTrip Orchestrator', '/tmp', project.id);
    plugin.manager.updateProject(project.id, { orchestratorThreadId: projectOrch.id });
    plugin.settings.scheduledItems = [
      { id: 'portfolio-heartbeat', name: 'P', prompt: 'p', schedule: { type: 'interval', intervalSeconds: 3600 }, enabled: true, targetThreadId: portfolio.id, isOrchestratorHeartbeat: true },
      { id: 'project-heartbeat', name: 'J', prompt: 'j', schedule: { type: 'interval', intervalSeconds: 3600 }, enabled: true, targetThreadId: projectOrch.id, projectId: project.id, isOrchestratorHeartbeat: true },
    ];

    await plugin.retireOrchestratorThread(portfolio.id);
    await plugin.retireOrchestratorThread(projectOrch.id);

    expect(deleteItem).toHaveBeenCalledWith('portfolio-heartbeat');
    expect(deleteItem).toHaveBeenCalledWith('project-heartbeat');
    expect(plugin.settings.orchestratorThreadId).toBeUndefined();
    expect(plugin.manager.getProject(project.id)?.orchestratorThreadId).toBeUndefined();
  });

  it('creates one Project orchestrator and one Project-aware heartbeat without opening it', async () => {
    const { plugin, createItem } = makePlugin();
    plugin.manager.vaultRoot = '/vault';
    const project = plugin.manager.createProject('HipTrip', 'Products/HipTrip', undefined, '/repos/hiptrip');

    const threadId = await plugin.ensureProjectOrchestratorThread(project.id, false);
    const reusedId = await plugin.ensureProjectOrchestratorThread(project.id, false);

    expect(reusedId).toBe(threadId);
    expect(plugin.manager.getProject(project.id)?.orchestratorThreadId).toBe(threadId);
    expect(plugin.manager.getThread(threadId!)!).toMatchObject({ title: 'HipTrip Orchestrator', cwd: '/repos/hiptrip', projectId: project.id });
    expect(createItem).toHaveBeenCalledOnce();
    expect(createItem).toHaveBeenCalledWith(expect.objectContaining({ targetThreadId: threadId, projectId: project.id, isOrchestratorHeartbeat: true }));
    expect(plugin.openThreadInChatView).not.toHaveBeenCalled();
  });

  it('deletes heartbeat items targeting the stale thread id when recreating the orchestrator thread', async () => {
    const { plugin, deleteItem } = makePlugin();

    // Simulate a previously-created orchestrator thread that's since been
    // deleted/archived: settings still points at it, but manager.getThread()
    // returns undefined.
    const staleId = 'stale-orchestrator-thread-id';
    plugin.settings.orchestratorThreadId = staleId;
    const staleHeartbeat: ScheduledItem = {
      id: 'heartbeat-1',
      name: 'Thread Orchestrator Heartbeat',
      prompt: 'Heartbeat: run your review pass across all threads.',
      schedule: { type: 'interval', intervalSeconds: 3600 },
      enabled: true,
      targetThreadId: staleId,
      isOrchestratorHeartbeat: true,
    };
    // An unrelated scheduled item targeting the same stale id but NOT marked
    // as the orchestrator's own heartbeat — must not be deleted.
    const unrelatedItem: ScheduledItem = {
      id: 'unrelated-1',
      name: 'Some other loop',
      prompt: 'do something else',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: staleId,
    };
    plugin.settings.scheduledItems = [staleHeartbeat, unrelatedItem];

    await plugin.ensureOrchestratorThread();

    expect(deleteItem).toHaveBeenCalledOnce();
    expect(deleteItem).toHaveBeenCalledWith('heartbeat-1');

    // A new orchestrator thread was created and settings now point at it.
    expect(plugin.settings.orchestratorThreadId).toBeDefined();
    expect(plugin.settings.orchestratorThreadId).not.toBe(staleId);
  });

  it('does not call deleteItem when reusing an existing valid orchestrator thread', async () => {
    const { plugin, deleteItem, createItem } = makePlugin();

    const thread = plugin.manager.createThread('Thread Orchestrator', '/tmp');
    plugin.settings.orchestratorThreadId = thread.id;
    plugin.settings.scheduledItems = [
      {
        id: 'heartbeat-existing',
        name: 'Thread Orchestrator Heartbeat',
        prompt: 'Heartbeat: run your review pass across all threads.',
        schedule: { type: 'interval', intervalSeconds: 3600 },
        enabled: true,
        targetThreadId: thread.id,
        isOrchestratorHeartbeat: true,
      },
    ];

    await plugin.ensureOrchestratorThread();

    expect(deleteItem).not.toHaveBeenCalled();
    // Heartbeat already exists for this thread, so no new one is created either.
    expect(createItem).not.toHaveBeenCalled();
    expect(plugin.settings.orchestratorThreadId).toBe(thread.id);
  });

  it('does not call deleteItem on first-ever creation (no stale id to clean up)', async () => {
    const { plugin, deleteItem, createItem } = makePlugin();

    plugin.settings.orchestratorThreadId = undefined;
    plugin.settings.scheduledItems = [];

    await plugin.ensureOrchestratorThread();

    expect(deleteItem).not.toHaveBeenCalled();
    expect(createItem).toHaveBeenCalledOnce();
    const createArgs = createItem.mock.calls[0][0];
    expect(createArgs.isOrchestratorHeartbeat).toBe(true);
    expect(createArgs.targetThreadId).toBe(plugin.settings.orchestratorThreadId);
  });
});

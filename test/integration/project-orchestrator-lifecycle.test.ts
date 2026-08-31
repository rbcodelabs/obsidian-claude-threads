import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { OrchestratorWakeup } from '../../src/OrchestratorWakeup';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type ScheduledItem } from '../../src/types';

function pluginFixture() {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS, defaultCwd: '/root', scheduledItems: [] };
  plugin.manager = new ThreadManager(plugin.settings);
  (plugin as unknown as { saveData: (value: unknown) => Promise<void> }).saveData = vi.fn();
  (plugin as unknown as { openThreadInChatView: (id: string) => Promise<void> }).openThreadInChatView = vi.fn();
  const createItem = vi.fn(async (item: Omit<ScheduledItem, 'id'>) => {
    plugin.settings.scheduledItems!.push({ ...item, id: crypto.randomUUID() });
  });
  (plugin as unknown as { scheduler: { createItem: typeof createItem } }).scheduler = { createItem };
  return { plugin, createItem };
}

describe('Project orchestrator lifecycle integration', () => {
  it('auto-creates one Project orchestrator and heartbeat, then rolls its completion to portfolio', async () => {
    const { plugin, createItem } = pluginFixture();
    const project = plugin.manager.createProject('HipTrip', 'HipTrip', undefined, '/repo');
    const worker = plugin.manager.createThread('Worker', '/repo', project.id);
    const portfolio = plugin.manager.createThread('Portfolio', '/root');
    plugin.settings.orchestratorThreadId = portfolio.id;
    const callbacks: Array<() => void> = [];
    const sent = vi.fn().mockResolvedValue(undefined);
    const wakeup = new OrchestratorWakeup(plugin.manager, {
      resolveBucket: (threadId) => {
        const thread = plugin.manager.getThread(threadId)!;
        if (threadId === plugin.settings.orchestratorThreadId) return undefined;
        const owningProject = thread.projectId ? plugin.manager.getProject(thread.projectId) : undefined;
        return owningProject?.orchestratorThreadId === threadId ? 'portfolio' : `project:${thread.projectId}`;
      },
      resolveTarget: async bucket => bucket === 'portfolio' ? portfolio.id : plugin.ensureProjectOrchestratorThread(project.id, false),
      threadExists: id => !!plugin.manager.getThread(id), sendMessage: sent,
      setTimeoutFn: cb => { callbacks.push(cb); return cb; }, clearTimeoutFn: () => {},
    });
    wakeup.start();

    (plugin.manager as unknown as { emit: (id: string, event: { type: 'done' }) => void }).emit(worker.id, { type: 'done' });
    callbacks.shift()!();
    await vi.waitFor(() => expect(createItem).toHaveBeenCalledOnce());
    const projectOrchestratorId = plugin.manager.getProject(project.id)!.orchestratorThreadId!;
    expect(sent).toHaveBeenCalledWith(projectOrchestratorId, expect.stringContaining(worker.id));

    (plugin.manager as unknown as { emit: (id: string, event: { type: 'done' }) => void }).emit(projectOrchestratorId, { type: 'done' });
    callbacks.shift()!(); await Promise.resolve(); await Promise.resolve();
    expect(sent).toHaveBeenCalledWith(portfolio.id, expect.stringContaining(projectOrchestratorId));
    wakeup.stop();
  });
});

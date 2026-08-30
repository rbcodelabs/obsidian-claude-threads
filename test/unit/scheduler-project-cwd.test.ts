import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, type SchedulerOptions } from '../../src/Scheduler';

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

function setup(projectCwds: Record<string, string> = { project: '/repos/old' }) {
  const createThread = vi.fn().mockReturnValue({ id: 'thread' });
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const runGate = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread,
    sendMessage,
    getDefaultCwd: () => '/global',
    getProjectCwd: (id) => projectCwds[id],
    threadExists: (id) => id === 'target',
    runGate,
  };
  const scheduler = new Scheduler(options);
  scheduler.start([]);
  return { scheduler, createThread, sendMessage, runGate };
}

describe('Scheduler project cwd resolution', () => {
  it('resolves project cwd dynamically at fire time and uses it for gate and thread', async () => {
    const projectCwds = { project: '/repos/old' };
    const { scheduler, createThread, runGate } = setup(projectCwds);
    await scheduler.createItem({
      name: 'Job', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
      projectId: 'project', gate: { command: 'check' },
    });
    projectCwds.project = '/repos/new';

    await vi.advanceTimersByTimeAsync(61_000);

    expect(runGate.mock.calls[0][1].cwd).toBe('/repos/new');
    expect(createThread).toHaveBeenCalledWith('Job', '/repos/new', 'project', expect.any(String));
    scheduler.destroy();
  });

  it('prefers an explicit item cwd over the project cwd', async () => {
    const { scheduler, createThread } = setup();
    await scheduler.createItem({
      name: 'Job', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
      projectId: 'project', cwd: '/explicit',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalledWith('Job', '/explicit', 'project', expect.any(String));
    scheduler.destroy();
  });

  it('resolves an explicit cwd without consulting a stale Project', () => {
    const { scheduler } = setup({});

    expect(scheduler.getEffectiveCwd({ cwd: '/explicit', projectId: 'deleted' })).toBe('/explicit');
    scheduler.destroy();
  });

  it('rejects unknown projects on create and update', async () => {
    const { scheduler } = setup();
    await expect(scheduler.createItem({
      name: 'Bad', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
      projectId: 'missing',
    })).rejects.toThrow('Project not found: missing');
    const item = await scheduler.createItem({
      name: 'Good', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
    });
    await expect(scheduler.updateItem(item.id, { projectId: 'missing' })).rejects.toThrow('Project not found: missing');
    scheduler.destroy();
  });

  it('records a failed run and does not dispatch when a referenced project is deleted', async () => {
    const projectCwds: Record<string, string> = { project: '/repos/repo' };
    const { scheduler, createThread, sendMessage } = setup(projectCwds);
    const item = await scheduler.createItem({
      name: 'Job', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
      projectId: 'project',
    });
    delete projectCwds.project;

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(scheduler.getItem(item.id)?.runHistory?.at(-1)).toMatchObject({
      outcome: 'error', note: 'Project not found: project',
    });
    scheduler.destroy();
  });

  it('fails a stale-Project new-thread job even when it has an explicit cwd', async () => {
    const projectCwds: Record<string, string> = { project: '/repos/repo' };
    const { scheduler, createThread, sendMessage } = setup(projectCwds);
    const item = await scheduler.createItem({
      name: 'Job', prompt: 'run', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
      projectId: 'project', cwd: '/explicit',
    });
    delete projectCwds.project;

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(scheduler.getItem(item.id)?.runHistory?.at(-1)).toMatchObject({
      outcome: 'error', note: 'Project not found: project',
    });
    scheduler.destroy();
  });

  it('continues a live target-thread job without a gate after its Project is deleted', async () => {
    const projectCwds: Record<string, string> = { project: '/repos/repo' };
    const { scheduler, createThread, sendMessage } = setup(projectCwds);
    await scheduler.createItem({
      name: 'Loop', prompt: 'continue', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
      projectId: 'project', targetThreadId: 'target',
    });
    delete projectCwds.project;

    await vi.advanceTimersByTimeAsync(61_000);

    expect(sendMessage).toHaveBeenCalledWith('target', 'continue');
    expect(createThread).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  it('uses explicit cwd for a gated live target after its Project is deleted', async () => {
    const projectCwds: Record<string, string> = { project: '/repos/repo' };
    const { scheduler, createThread, sendMessage, runGate } = setup(projectCwds);
    await scheduler.createItem({
      name: 'Loop', prompt: 'continue', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
      projectId: 'project', targetThreadId: 'target', cwd: '/explicit', gate: { command: 'check' },
    });
    delete projectCwds.project;

    await vi.advanceTimersByTimeAsync(61_000);

    expect(runGate.mock.calls[0][1].cwd).toBe('/explicit');
    expect(sendMessage).toHaveBeenCalledWith('target', 'continue');
    expect(createThread).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  it('fails a gated live target with no explicit cwd after its Project is deleted', async () => {
    const projectCwds: Record<string, string> = { project: '/repos/repo' };
    const { scheduler, createThread, sendMessage, runGate } = setup(projectCwds);
    const item = await scheduler.createItem({
      name: 'Loop', prompt: 'continue', schedule: { type: 'interval', intervalSeconds: 60 }, enabled: true,
      projectId: 'project', targetThreadId: 'target', gate: { command: 'check' },
    });
    delete projectCwds.project;

    await vi.advanceTimersByTimeAsync(61_000);

    expect(runGate).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
    expect(scheduler.getItem(item.id)?.runHistory?.at(-1)).toMatchObject({
      outcome: 'error', note: 'Project not found: project',
    });
    scheduler.destroy();
  });
});

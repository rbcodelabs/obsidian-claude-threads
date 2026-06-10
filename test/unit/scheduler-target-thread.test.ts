import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, type SchedulerOptions } from '../../src/Scheduler';

// Scheduler uses window.setTimeout/clearTimeout; alias window to globalThis so
// the fake timers installed by vitest are what the scheduler arms.
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
});

function makeOptions(overrides: Partial<SchedulerOptions> = {}): {
  options: SchedulerOptions;
  sendMessage: ReturnType<typeof vi.fn>;
  createThread: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const createThread = vi.fn().mockReturnValue({ id: 'new-thread' });
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread,
    sendMessage,
    getDefaultCwd: () => '/tmp',
    ...overrides,
  };
  return { options, sendMessage, createThread };
}

describe('Scheduler targetThreadId (loops)', () => {
  it('sends the prompt into the existing target thread when it exists', async () => {
    const { options, sendMessage, createThread } = makeOptions({
      threadExists: (id) => id === 'thread-1',
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'thread-1',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(sendMessage).toHaveBeenCalledWith('thread-1', 'check the build');
    expect(createThread).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  it('falls back to creating a new thread when the target thread is gone', async () => {
    const { options, sendMessage, createThread } = makeOptions({
      threadExists: () => false,
    });
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'deleted-thread',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('new-thread', 'check the build');
    scheduler.destroy();
  });

  it('creates a new thread when threadExists is not provided (backwards compat)', async () => {
    const { options, sendMessage, createThread } = makeOptions();
    const scheduler = new Scheduler(options);
    scheduler.start([]);

    scheduler.createItem({
      name: 'Loop: check build',
      prompt: 'check the build',
      schedule: { type: 'interval', intervalSeconds: 60 },
      enabled: true,
      targetThreadId: 'thread-1',
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(createThread).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('new-thread', 'check the build');
    scheduler.destroy();
  });
});

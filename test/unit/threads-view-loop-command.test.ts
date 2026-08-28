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

function makeScheduler(): { scheduler: Scheduler; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const options: SchedulerOptions = {
    getItems: () => [],
    saveItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockReturnValue({ id: 'new-thread' }),
    sendMessage,
    getDefaultCwd: () => '/tmp',
    threadExists: () => true,
  };
  const scheduler = new Scheduler(options);
  scheduler.start([]);
  return { scheduler, sendMessage };
}

async function replaceThreadLoop(
  scheduler: Scheduler,
  threadId: string,
  prompt: string,
  intervalSeconds: number,
  sendMessage: (threadId: string, prompt: string) => Promise<void>,
): Promise<void> {
  const loops = scheduler.listItems().filter((item) =>
    item.enabled && item.targetThreadId === threadId && item.schedule.type === 'interval',
  );
  await Promise.all(loops.map((loop) => scheduler.deleteItem(loop.id)));
  await scheduler.createItem({
    name: `Loop: ${prompt.slice(0, 40)}`,
    prompt,
    schedule: { type: 'interval', intervalSeconds },
    enabled: true,
    targetThreadId: threadId,
  });
  void sendMessage(threadId, prompt);
}

async function stopThreadLoops(scheduler: Scheduler, threadId: string): Promise<void> {
  const loops = scheduler.listItems().filter((item) =>
    item.enabled && item.targetThreadId === threadId && item.schedule.type === 'interval',
  );
  await Promise.all(loops.map((loop) => scheduler.deleteItem(loop.id)));
}

describe('/loop scheduler behavior', () => {
  it('sends the loop prompt immediately', async () => {
    const { scheduler, sendMessage } = makeScheduler();
    await replaceThreadLoop(scheduler, 'thread-1', 'check the build', 300, sendMessage);
    expect(sendMessage).toHaveBeenCalledWith('thread-1', 'check the build');
    scheduler.destroy();
  });

  it('replaces only the existing interval and preserves a pending wakeup', async () => {
    const { scheduler, sendMessage } = makeScheduler();
    await scheduler.createItem({
      name: 'Wakeup: check CI', prompt: 'check CI', origin: 'wakeup',
      schedule: { type: 'once', fireAt: Date.now() + 60_000 }, enabled: true, targetThreadId: 'thread-1',
    });
    await replaceThreadLoop(scheduler, 'thread-1', 'first loop', 60, sendMessage);
    await replaceThreadLoop(scheduler, 'thread-1', 'replacement loop', 120, sendMessage);

    const items = scheduler.listItems().filter((item) => item.targetThreadId === 'thread-1');
    expect(items.filter((item) => item.origin === 'wakeup')).toHaveLength(1);
    expect(items.filter((item) => item.schedule.type === 'interval')).toEqual([
      expect.objectContaining({ prompt: 'replacement loop', schedule: expect.objectContaining({ intervalSeconds: 120 }) }),
    ]);
    scheduler.destroy();
  });

  it('/loop stop removes intervals and preserves a pending wakeup', async () => {
    const { scheduler, sendMessage } = makeScheduler();
    await scheduler.createItem({
      name: 'Wakeup: check CI', prompt: 'check CI', origin: 'wakeup',
      schedule: { type: 'once', fireAt: Date.now() + 60_000 }, enabled: true, targetThreadId: 'thread-1',
    });
    await replaceThreadLoop(scheduler, 'thread-1', 'loop prompt', 60, sendMessage);
    await stopThreadLoops(scheduler, 'thread-1');

    const items = scheduler.listItems().filter((item) => item.targetThreadId === 'thread-1');
    expect(items).toHaveLength(1);
    expect(items[0].origin).toBe('wakeup');
    scheduler.destroy();
  });
});

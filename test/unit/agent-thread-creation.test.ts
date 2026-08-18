import { describe, expect, it, vi } from 'vitest';
import { createAgentThreadCallback } from '../../src/main';

describe('agent thread creation wiring', () => {
  it('inherits source context, clears an explicitly null project, queues the prompt, and returns identity', async () => {
    const sourceThread = { cwd: '/source/repo', projectId: 'project-1' };
    const createThread = vi.fn()
      .mockReturnValueOnce({ id: 'thread-1', title: 'Investigate auth' })
      .mockReturnValueOnce({ id: 'thread-2', title: 'Independent task' });
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const callback = createAgentThreadCallback({
      sourceThreadId: 'source-thread',
      getThread: vi.fn().mockReturnValue(sourceThread),
      createThread,
      saveSettings,
      sendMessage,
    });

    await expect(callback({ prompt: 'Investigate auth' })).resolves.toEqual({
      threadId: 'thread-1',
      title: 'Investigate auth',
    });
    expect(createThread).toHaveBeenNthCalledWith(1, 'Investigate auth', '/source/repo', 'project-1');
    expect(sendMessage).toHaveBeenNthCalledWith(1, 'thread-1', 'Investigate auth');

    await expect(callback({ prompt: 'Do the work', title: 'Independent task', projectId: null })).resolves.toEqual({
      threadId: 'thread-2',
      title: 'Independent task',
    });
    expect(createThread).toHaveBeenNthCalledWith(2, 'Independent task', '/source/repo', undefined);
    expect(sendMessage).toHaveBeenNthCalledWith(2, 'thread-2', 'Do the work');
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });
});

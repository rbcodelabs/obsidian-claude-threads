import { describe, expect, it, vi } from 'vitest';
import { createDeferredThreadArchiver } from '../../src/deferredThreadArchive';

describe('createDeferredThreadArchiver', () => {
  it('archives a requested thread after run_state_settled, never before', async () => {
    let listener: ((threadId: string, event: { type: string }) => void) | undefined;
    let running = true;
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const manager = {
      subscribe: vi.fn((callback: typeof listener) => {
        listener = callback;
        return () => undefined;
      }),
      isRunning: vi.fn(() => running),
    };
    const controller = createDeferredThreadArchiver(manager, archiveThread);

    controller.request('scheduled-thread');
    expect(archiveThread).not.toHaveBeenCalled();

    listener?.('scheduled-thread', { type: 'done' });
    expect(archiveThread).not.toHaveBeenCalled();

    listener?.('scheduled-thread', { type: 'run_state_settled' });
    expect(archiveThread).not.toHaveBeenCalled();

    running = false;
    listener?.('scheduled-thread', { type: 'run_state_settled' });
    await vi.waitFor(() => expect(archiveThread).toHaveBeenCalledWith('scheduled-thread'));
  });
});

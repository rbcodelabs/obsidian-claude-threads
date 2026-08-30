import { describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';

describe('ThreadsView.focusThread', () => {
  it('resolves only after the active thread is fully selected', async () => {
    let release!: () => void;
    const selection = new Promise<void>((resolve) => { release = resolve; });
    const view = Object.create(ThreadsView.prototype) as ThreadsView;
    (view as unknown as { setActiveThread(id: string): Promise<void> }).setActiveThread =
      vi.fn(() => selection);

    let settled = false;
    const focused = view.focusThread('thread-1').then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await focused;
    expect(settled).toBe(true);
  });
});

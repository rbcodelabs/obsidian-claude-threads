import { describe, expect, it, vi } from 'vitest';
import { PersistenceWriterFence } from '../../src/PersistenceWriterFence';

describe('PersistenceWriterFence', () => {
  it('drains the prior generation before the replacement reads canonical state', async () => {
    const fence = new PersistenceWriterFence();
    const first = fence.claim();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const oldWrite = fence.write(first, async () => {
      events.push('old-write-start');
      await blocked;
      events.push('old-write-end');
    });
    await vi.waitFor(() => expect(events).toEqual(['old-write-start']));

    const replacement = fence.claim();
    const ready = fence.drain().then(() => events.push('replacement-read'));
    release();
    await Promise.all([oldWrite, ready]);

    expect(replacement).not.toBe(first);
    expect(events).toEqual(['old-write-start', 'old-write-end', 'replacement-read']);
  });

  it('drops queued writes from a stale generation after a replacement claims ownership', async () => {
    const fence = new PersistenceWriterFence();
    const stale = fence.claim();
    const current = fence.claim();
    const writes: string[] = [];

    await fence.write(stale, async () => { writes.push('stale'); });
    await fence.write(current, async () => { writes.push('current'); });

    expect(writes).toEqual(['current']);
  });
});

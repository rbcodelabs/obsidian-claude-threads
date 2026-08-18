export type PersistenceWriterToken = symbol;

/**
 * Coordinates persistence across overlapping plugin generations. A replacement
 * claims ownership synchronously, waits for the prior in-flight write, and
 * causes any older queued write to become a no-op.
 */
export class PersistenceWriterFence {
  private current: PersistenceWriterToken | null = null;
  private tail: Promise<void> = Promise.resolve();

  claim(): PersistenceWriterToken {
    const token = Symbol('claude-threads-persistence-generation');
    this.current = token;
    return token;
  }

  drain(): Promise<void> {
    return this.tail;
  }

  write(token: PersistenceWriterToken, operation: () => Promise<void>): Promise<void> {
    // Admission is decided synchronously. Work admitted before a replacement
    // claim must drain so the replacement reads its result; calls made by the
    // stale generation after the claim are rejected immediately.
    if (this.current !== token) return Promise.resolve();
    const run = this.tail.then(operation);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

const FENCE_KEY = Symbol.for('claude-threads.persistence-writer-fence');
type FenceGlobal = typeof globalThis & { [FENCE_KEY]?: PersistenceWriterFence };

export function sharedPersistenceWriterFence(): PersistenceWriterFence {
  const state = globalThis as FenceGlobal;
  return state[FENCE_KEY] ??= new PersistenceWriterFence();
}

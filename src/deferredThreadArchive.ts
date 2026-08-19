export interface DeferredArchiveManager {
  subscribe(listener: (threadId: string, event: { type: string }) => void): () => void;
  isRunning(threadId: string): boolean;
}

export interface DeferredThreadArchiver {
  request(threadId: string): void;
  dispose(): void;
}

/** Defers self-archive until the current tool result and turn have settled. */
export function createDeferredThreadArchiver(
  manager: DeferredArchiveManager,
  archiveThread: (threadId: string) => Promise<void>,
): DeferredThreadArchiver {
  const pending = new Set<string>();
  const unsubscribe = manager.subscribe((threadId, event) => {
    if (event.type !== 'run_state_settled' || !pending.has(threadId) || manager.isRunning(threadId)) return;
    pending.delete(threadId);
    void archiveThread(threadId).catch((error) => {
      console.error('[ClaudeThreads] Deferred thread archive failed:', error);
    });
  });

  return {
    request(threadId) {
      pending.add(threadId);
    },
    dispose() {
      pending.clear();
      unsubscribe();
    },
  };
}

import type { Thread } from './types';

export interface VaultThreadRecoveryOptions {
  knownIds: ReadonlySet<string>;
  loadAllThreads: () => Promise<Thread[]>;
  loadRecoveredThreads: (threads: Thread[]) => void;
  markOrphanArchiveScanIncomplete: () => void;
  saveSettings: () => Promise<void>;
  logRecovered?: (count: number) => void;
  logError?: (error: unknown) => void;
}

/** Start crash recovery without making plugin startup wait for vault I/O. */
export function scheduleVaultThreadRecovery(options: VaultThreadRecoveryOptions): void {
  void (async () => {
    const vaultThreads = await options.loadAllThreads();
    const recovered = vaultThreads.filter(
      (thread) => !options.knownIds.has(thread.id) && thread.status !== 'archived',
    );
    for (const thread of recovered) {
      if (thread.status === 'active') thread.status = 'waiting';
    }
    if (recovered.length === 0) return;

    options.loadRecoveredThreads(recovered);
    options.logRecovered?.(recovered.length);
    options.markOrphanArchiveScanIncomplete();
    await options.saveSettings();
  })().catch((error: unknown) => {
    options.logError?.(error);
  });
}

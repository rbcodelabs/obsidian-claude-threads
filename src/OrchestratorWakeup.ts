/**
 * OrchestratorWakeup — event-driven wake-up for the thread-orchestrator thread.
 *
 * Rather than polling on a fixed schedule, the orchestrator should "feel"
 * continuously running: whenever any other thread finishes a turn (done or
 * error), this pings the orchestrator thread to run its review pass. Multiple
 * threads finishing within a short window are batched into a single ping via
 * a debounce timer, so a burst of completions doesn't spam multiple messages.
 *
 * The 60-minute CronCreate heartbeat set up alongside the orchestrator thread
 * (see main.ts ensureOrchestratorThread()) is a resilience backstop for missed
 * events only — this class is the primary trigger.
 *
 * Structurally mirrors GitDiffService/StatusLineService: a small class taking
 * an injected-dependency object so it can be unit tested without a real
 * ThreadManager or Obsidian environment.
 */
import type { ThreadManager, ThreadEvent } from './ThreadManager';

export interface OrchestratorWakeupDeps {
  /** Returns the current orchestrator thread id, or undefined if not set up yet. */
  getOrchestratorThreadId: () => string | undefined;
  /** Returns true if a thread with the given id still exists. */
  threadExists: (threadId: string) => boolean;
  /** Sends the wake-up ping to the orchestrator thread. */
  sendMessage: (threadId: string, text: string) => Promise<void>;
  /** ms to wait after the last completion before flushing a batched ping. Default 12000. */
  debounceMs?: number;
  /** Injectable timer functions for deterministic tests. Default to the global timers. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Called with a warning message when the orchestrator thread no longer exists at flush time. */
  onWarn?: (message: string) => void;
  /** Called when sendMessage rejects. */
  onError?: (error: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 12_000;

export class OrchestratorWakeup {
  private manager: ThreadManager;
  private deps: OrchestratorWakeupDeps;
  private unsubscribe: (() => void) | null = null;
  private pending = new Set<string>();
  private timer: unknown = null;

  constructor(manager: ThreadManager, deps: OrchestratorWakeupDeps) {
    this.manager = manager;
    this.deps = deps;
  }

  start(): void {
    if (this.unsubscribe) return; // already started
    this.unsubscribe = this.manager.subscribe((threadId, event) => this.onEvent(threadId, event));
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.clearTimer();
    this.pending.clear();
  }

  private onEvent(threadId: string, event: ThreadEvent): void {
    if (event.type !== 'done' && event.type !== 'error') return;

    const orchestratorId = this.deps.getOrchestratorThreadId();
    if (!orchestratorId) return; // orchestrator not set up yet — nothing to wake
    if (threadId === orchestratorId) return; // never ping itself

    this.pending.add(threadId);
    this.armTimer(orchestratorId);
  }

  private armTimer(orchestratorId: string): void {
    this.clearTimer();
    const setTimeoutFn = this.deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    const debounceMs = this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.timer = setTimeoutFn(() => {
      this.timer = null;
      void this.flush(orchestratorId);
    }, debounceMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimeoutFn(this.timer);
    this.timer = null;
  }

  private async flush(orchestratorId: string): Promise<void> {
    const count = this.pending.size;
    this.pending.clear();
    if (count === 0) return;

    if (!this.deps.threadExists(orchestratorId)) {
      this.deps.onWarn?.(`Orchestrator wake-up: thread ${orchestratorId} no longer exists, skipping`);
      return;
    }

    try {
      await this.deps.sendMessage(
        orchestratorId,
        `New activity on ${count} thread${count === 1 ? '' : 's'} — run your review pass.`,
      );
    } catch (err) {
      this.deps.onError?.(err);
    }
  }
}

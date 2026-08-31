import type { Thread } from './types';

/**
 * Idle-thread auto-archive selection (ADR-0003, PR 2).
 *
 * Finished threads used to accumulate in data.json forever because archival was
 * manual-only. The sweep in main.ts auto-archives threads that have sat idle in
 * the `waiting` state past a configurable threshold, reusing the exact same
 * eviction path as the manual archive MCP handler.
 *
 * The selection predicate lives here as a pure function so it can be unit-tested
 * without a live plugin runtime, mirroring how PR 1 put its pure image logic in
 * imageExternalization.ts. It reads no wall clock and touches no Obsidian API:
 * `now` is injected by the caller.
 */

/** The subset of a Thread the idle-archive predicate needs to inspect. */
export type IdleArchiveCandidate = Pick<
  Thread,
  'id' | 'status' | 'updatedAt' | 'pendingPlan' | 'pendingQuestions'
>;

export interface IdleArchiveOptions {
  /** Threshold in days. `0` (or any falsy value) disables the sweep entirely. */
  autoArchiveIdleDays: number;
  /** Current time as epoch ms, injected so the predicate stays pure/testable. */
  now: number;
  /** The orchestrator thread is never auto-archived. */
  orchestratorThreadId?: string;
  /** All portfolio and Project orchestrator ids protected from automatic archive. */
  orchestratorThreadIds?: string[];
}

const MS_PER_DAY = 86_400_000;

/**
 * True when a single thread is eligible for idle auto-archive. A thread qualifies
 * only when it is `waiting` (terminal-ish), is not the orchestrator, has no
 * pending plan or question awaiting the user, and its last activity is older than
 * the configured threshold. `active`, `reconnecting`, and `error` threads never
 * qualify because their status is not `waiting`. When the threshold is `0`
 * (disabled) nothing qualifies.
 */
export function isThreadIdleForArchive(
  thread: IdleArchiveCandidate,
  opts: IdleArchiveOptions,
): boolean {
  if (!opts.autoArchiveIdleDays || opts.autoArchiveIdleDays <= 0) return false;
  if (thread.status !== 'waiting') return false;
  if (opts.orchestratorThreadId && thread.id === opts.orchestratorThreadId) return false;
  if (opts.orchestratorThreadIds?.includes(thread.id)) return false;
  if (thread.pendingPlan) return false;
  if (thread.pendingQuestions && thread.pendingQuestions.length > 0) return false;
  const idleMs = opts.autoArchiveIdleDays * MS_PER_DAY;
  return opts.now - thread.updatedAt > idleMs;
}

/**
 * Returns the threads that should be auto-archived this sweep. Returns an empty
 * array when the sweep is disabled (`autoArchiveIdleDays` falsy/0) so the caller
 * can short-circuit cheaply.
 */
export function selectIdleThreadsForArchive<T extends IdleArchiveCandidate>(
  threads: T[],
  opts: IdleArchiveOptions,
): T[] {
  if (!opts.autoArchiveIdleDays || opts.autoArchiveIdleDays <= 0) return [];
  return threads.filter((t) => isThreadIdleForArchive(t, opts));
}

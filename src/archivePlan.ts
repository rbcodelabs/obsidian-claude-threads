/**
 * Pure guard/confirm branching for the archive context menu.
 *
 * Everything that decides *whether* an archive may proceed and *what single
 * dialog* the user is shown lives here, with no DOM and no Obsidian imports, so
 * the interesting rules (bulk + running + orchestrator must still yield exactly
 * ONE modal) are unit-testable in isolation.
 */

import {
  describeOrchestratorThread,
  orchestratorWarning,
  type OrchestratorContext,
  type OrchestratorRole,
} from './orchestratorThreads';

/** The only Thread fields the plan needs. Keeps this module free of `types.ts`. */
export interface ArchivePlanThread {
  id: string;
  title: string;
}

export interface ArchivePlanContext {
  /** Every live (non-archived) thread, in whatever order the view holds them. */
  threads: ReadonlyArray<ArchivePlanThread>;
  isRunning(id: string): boolean;
  orchestrator: OrchestratorContext;
}

/** A single confirmation dialog spec. There is never more than one per plan. */
export interface ArchiveConfirm {
  message: string;
  confirmLabel: string;
}

export interface ArchivePlan {
  /** Live ids to archive, de-duplicated, in requested order. Empty when blocked. */
  ids: string[];
  /** Requested ids that no longer resolve to a live thread — silently dropped. */
  missingIds: string[];
  /** Subset of `ids` whose session is still streaming. */
  runningIds: string[];
  /** Subset of `ids` that own a Project or the portfolio, with their role. */
  orchestrators: Array<{ id: string; role: OrchestratorRole }>;
  /** True when the archive must not proceed at all. */
  blocked: boolean;
  /** User-facing reason, set iff `blocked`. */
  blockedMessage: string | null;
  /** At most one modal — never a stack of them. Null means archive immediately. */
  confirm: ArchiveConfirm | null;
}

/** Inputs to the confirm-copy composer, split out so it can be tested directly. */
export interface ArchiveConfirmParts {
  /** Live ids about to be archived. Its length drives the singular/bulk wording. */
  ids: string[];
  /** Title lookup, used only for the single-thread "<title> is still running" line. */
  titleOf(id: string): string;
  runningIds: string[];
  orchestrators: Array<{ id: string; role: OrchestratorRole }>;
}

function blockedPlan(message: string, missingIds: string[]): ArchivePlan {
  return {
    ids: [],
    missingIds,
    runningIds: [],
    orchestrators: [],
    blocked: true,
    blockedMessage: message,
    confirm: null,
  };
}

/**
 * Resolves a requested id set into an executable plan.
 *
 * The phases run in a fixed order, and only the last one can produce a dialog:
 *
 * 1. de-duplicate, preserving the caller's order;
 * 2. drop ids that no longer resolve — if nothing live is left, block;
 * 3. block if the set would archive every remaining thread;
 * 4. gather `runningIds` and `orchestrators` as *parallel facts*, not as
 *    sequential gates, so they can be composed into one dialog rather than
 *    two stacked ones.
 */
export function buildArchivePlan(requestedIds: string[], ctx: ArchivePlanContext): ArchivePlan {
  const byId = new Map(ctx.threads.map(thread => [thread.id, thread]));
  const unique = [...new Set(requestedIds)];

  const ids = unique.filter(id => byId.has(id));
  const missingIds = unique.filter(id => !byId.has(id));

  if (ids.length === 0) return blockedPlan('Those threads are already archived.', missingIds);
  if (ids.length >= ctx.threads.length) return blockedPlan("Can't archive the last remaining thread.", missingIds);

  const runningIds = ids.filter(id => ctx.isRunning(id));
  const orchestrators = ids
    .map(id => ({ id, role: describeOrchestratorThread(id, ctx.orchestrator) }))
    .filter((entry): entry is { id: string; role: OrchestratorRole } => entry.role !== null);

  const confirm = describeArchiveConfirm({
    ids,
    titleOf: id => byId.get(id)?.title ?? id,
    runningIds,
    orchestrators,
  });

  return { ids, missingIds, runningIds, orchestrators, blocked: false, blockedMessage: null, confirm };
}

/**
 * Composes at most one dialog from up to three sentences — scope, then running,
 * then orchestrator — so a bulk archive that also contains a running thread and
 * an orchestrator asks once instead of three times.
 *
 * Returns null for the common case: a single idle, non-orchestrator thread.
 * Right-click → menu → click is already a deliberate gesture, and the thread is
 * persisted to a vault note rather than destroyed.
 */
export function describeArchiveConfirm(parts: ArchiveConfirmParts): ArchiveConfirm | null {
  const count = parts.ids.length;
  const running = parts.runningIds.length;
  const isBulk = count > 1;

  if (!isBulk && running === 0 && parts.orchestrators.length === 0) return null;

  const sentences: string[] = [];

  if (isBulk) sentences.push(`Archive ${count} runs?`);

  if (running > 0) {
    sentences.push(
      isBulk
        ? `${running} of them ${running === 1 ? 'is' : 'are'} still running. Archiving ${running === 1 ? 'it stops that session' : 'them stops those sessions'}.`
        : `"${parts.titleOf(parts.runningIds[0])}" is still running. Archiving it stops the session.`,
    );
  }

  for (const { role } of parts.orchestrators) sentences.push(orchestratorWarning(role));

  return {
    message: sentences.join(' '),
    confirmLabel: running > 0 || parts.orchestrators.length > 0 ? 'Archive anyway' : 'Archive',
  };
}

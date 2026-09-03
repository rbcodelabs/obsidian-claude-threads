/**
 * Shared predicate for "is this thread an orchestrator?".
 *
 * The portfolio/Project orchestrator test was previously written out inline in
 * four places (main.ts:491, main.ts:1904, ThreadsView.canMoveToProject,
 * ThreadsView.closeThread) with no shared helper, so the warning copy and the
 * precedence rules could drift. This module is the single source of truth for
 * the predicate, the role it resolves to, and the warning shown before an
 * orchestrator is archived.
 */

/** Which kind of orchestrator a thread is, once it is known to be one. */
export type OrchestratorRole =
  | { kind: 'portfolio' }
  | { kind: 'project'; projectId: string; projectName: string };

/** The minimum a caller has to supply — settings plus the live Project list. */
export interface OrchestratorContext {
  /** `settings.orchestratorThreadId` — the Portfolio orchestrator, when one exists. */
  portfolioThreadId?: string;
  /** Every known Project; each may pin one thread as its Project orchestrator. */
  projects: ReadonlyArray<{ id: string; name: string; orchestratorThreadId?: string }>;
}

/**
 * Resolves a thread's orchestrator role, or null when it is an ordinary thread.
 *
 * Project ownership is checked **before** the portfolio id, matching the
 * precedence already shipped in `ThreadsView.closeThread`: it looked the
 * Project up first and preferred the Project wording whenever both matched.
 * The two roles are mutually exclusive in practice; this only fixes which
 * sentence a hand-edited settings file would produce.
 */
export function describeOrchestratorThread(id: string, ctx: OrchestratorContext): OrchestratorRole | null {
  const project = ctx.projects.find(candidate => candidate.orchestratorThreadId === id);
  if (project) return { kind: 'project', projectId: project.id, projectName: project.name };
  if (id && id === ctx.portfolioThreadId) return { kind: 'portfolio' };
  return null;
}

/** True for the Portfolio orchestrator and for any thread that owns a Project. */
export function isOrchestratorThread(id: string, ctx: OrchestratorContext): boolean {
  return describeOrchestratorThread(id, ctx) !== null;
}

/** Every orchestrator thread id currently in play, portfolio first, de-duplicated. */
export function listOrchestratorThreadIds(ctx: OrchestratorContext): string[] {
  const ids = [ctx.portfolioThreadId, ...ctx.projects.map(project => project.orchestratorThreadId)];
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/**
 * The confirmation copy shown before an orchestrator is archived. Kept verbatim
 * from the strings `ThreadsView.closeThread` has always shown so the dialog a
 * user sees is unchanged by the move to a shared helper.
 */
export function orchestratorWarning(role: OrchestratorRole): string {
  return role.kind === 'project'
    ? `This is the ${role.projectName} Project Orchestrator. Deleting it stops automatic Project review until it is recreated.`
    : 'This is your Portfolio Orchestrator. Deleting it stops portfolio review until you run "Open Portfolio Orchestrator" again to create a new one.';
}

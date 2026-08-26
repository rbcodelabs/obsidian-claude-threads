import type { AgentRun, AgentRunStatus } from '../types';

/**
 * The statuses that mean "this agent is still doing something". Mirrors the set
 * `ThreadManager.hasActiveBackgroundTasks` gates on, so the composer pill and the
 * thread's background-task state can never disagree about whether work is in flight.
 */
export const ACTIVE_AGENT_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  'starting',
  'working',
  'waiting',
]);

/** One row of the flattened agent tree, carrying its depth for indentation. */
export interface AgentTreeRow {
  run: AgentRun;
  /** 1-based depth, usable directly as `aria-level`. */
  level: number;
}

export type AgentTeamTone = 'active' | 'failed' | 'done' | 'idle';

export interface AgentTeamSummary {
  total: number;
  active: number;
  failed: number;
  /** Human-readable pill text, e.g. "2 agents working". */
  label: string;
  tone: AgentTeamTone;
}

/** Harness-generated placeholder descriptions that carry no meaning for a user. */
const GENERIC_DESCRIPTION = /^codex\s+sub-?agent\b/i;

/**
 * Resolves each run's usable parent id. A parent reference is only honoured when
 * it points at a different run that is actually present in this thread's set, and
 * when following it does not lead back to the run itself.
 *
 * `AgentRunStore.resolveParents` does not exclude self, so a harness that reports
 * an agent as its own parent produces a run whose `parentAgentRunId === id`. Left
 * unguarded that is an infinite loop in any ancestor walk, so cycles are broken
 * here once and every consumer inherits the fix.
 */
function resolveEffectiveParents(runs: AgentRun[]): Map<string, string | undefined> {
  const byId = new Map(runs.map(run => [run.id, run]));
  const parents = new Map<string, string | undefined>();
  for (const run of runs) {
    const declared = run.parentAgentRunId;
    if (!declared || declared === run.id || !byId.has(declared)) {
      parents.set(run.id, undefined);
      continue;
    }
    // Walk up the declared chain. If we arrive back at this run, the reference is
    // part of a cycle and this run is promoted to a root instead.
    const seen = new Set<string>();
    let cursor: string | undefined = declared;
    let cyclic = false;
    while (cursor) {
      if (cursor === run.id) { cyclic = true; break; }
      if (seen.has(cursor)) break; // a cycle elsewhere in the chain; this run is unaffected
      seen.add(cursor);
      const next: string | undefined = byId.get(cursor)?.parentAgentRunId;
      cursor = next && byId.has(next) ? next : undefined;
    }
    parents.set(run.id, cyclic ? undefined : declared);
  }
  return parents;
}

/**
 * Depth-first pre-order flattening of the parent/child agent graph, preserving the
 * caller's ordering (`AgentRunStore.getByThread` sorts by `startedAt`) within each
 * sibling group. Orphans and cycle members surface as roots rather than vanishing.
 */
export function flattenAgentTree(runs: AgentRun[]): AgentTreeRow[] {
  if (!runs.length) return [];
  const parents = resolveEffectiveParents(runs);
  const children = new Map<string | undefined, AgentRun[]>();
  for (const run of runs) {
    const parent = parents.get(run.id);
    const bucket = children.get(parent) ?? [];
    bucket.push(run);
    children.set(parent, bucket);
  }

  const rows: AgentTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | undefined, level: number): void => {
    for (const run of children.get(parentId) ?? []) {
      if (visited.has(run.id)) continue;
      visited.add(run.id);
      rows.push({ run, level });
      walk(run.id, level + 1);
    }
  };
  walk(undefined, 1);

  // Belt and braces: anything the walk could not reach still deserves a row.
  for (const run of runs) {
    if (visited.has(run.id)) continue;
    visited.add(run.id);
    rows.push({ run, level: 1 });
  }
  return rows;
}

/** Counts and pill text for a thread's agent team. */
export function summarizeAgentTeam(runs: AgentRun[]): AgentTeamSummary {
  const total = runs.length;
  const active = runs.filter(run => ACTIVE_AGENT_STATUSES.has(run.status)).length;
  const failed = runs.filter(run => run.status === 'failed').length;

  let label: string;
  let tone: AgentTeamTone;
  if (active > 0) {
    label = `${active} ${active === 1 ? 'agent' : 'agents'} working`;
    tone = 'active';
  } else if (failed > 0) {
    label = `${failed} ${failed === 1 ? 'agent' : 'agents'} failed`;
    tone = 'failed';
  } else if (total > 0) {
    label = `${total} ${total === 1 ? 'agent' : 'agents'}`;
    tone = runs.every(run => run.status === 'completed') ? 'done' : 'idle';
  } else {
    label = 'No agents';
    tone = 'idle';
  }
  return { total, active, failed, label, tone };
}

/**
 * Primary display name for a run. Prefers the harness-supplied role, falls back to
 * the description, and demotes generic harness placeholders such as
 * "Codex sub-agent 0f21" so they never occupy the strong label slot.
 */
export function agentLabel(run: AgentRun): string {
  const role = run.role?.trim();
  if (role) return role;
  const description = run.description?.trim();
  if (description && !GENERIC_DESCRIPTION.test(description)) return description;
  return 'Sub-agent';
}

/** Muted second line: live activity when known, otherwise the description or status. */
export function agentSubLabel(run: AgentRun): string {
  const activity = run.currentActivity?.trim();
  if (activity) return activity;
  const description = run.description?.trim();
  if (description && description !== agentLabel(run)) return description;
  return run.status;
}

/**
 * Root-to-selected ancestor chain for the breadcrumb bar. Returns an empty array
 * when nothing is selected or the selection is not in `runs`. The `visited` set
 * makes a self-parenting or cyclic run terminate instead of looping forever.
 */
export function buildAgentBreadcrumbs(runs: AgentRun[], selectedId: string | undefined): AgentRun[] {
  if (!selectedId) return [];
  const byId = new Map(runs.map(run => [run.id, run]));
  const chain: AgentRun[] = [];
  const visited = new Set<string>();
  let cursor = byId.get(selectedId);
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parentAgentRunId ? byId.get(cursor.parentAgentRunId) : undefined;
  }
  return chain;
}

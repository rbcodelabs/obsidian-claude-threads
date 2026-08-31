export type CoordinationRole =
  | { kind: 'portfolio' }
  | { kind: 'project-orchestrator'; projectId: string }
  | { kind: 'project-member'; projectId: string }
  | { kind: 'unassigned' };

export interface OrchestratedProjectRef {
  id: string;
  orchestratorThreadId?: string;
  orchestratorEnabled?: boolean;
}

export function resolveCoordinationRole(
  callerThreadId: string,
  portfolioOrchestratorThreadId: string | undefined,
  callerProjectId: string | undefined,
  projects: OrchestratedProjectRef[],
): CoordinationRole {
  if (callerThreadId === portfolioOrchestratorThreadId) return { kind: 'portfolio' };
  if (!callerProjectId) return { kind: 'unassigned' };
  const project = projects.find(candidate => candidate.id === callerProjectId);
  if (project?.orchestratorThreadId === callerThreadId) {
    return { kind: 'project-orchestrator', projectId: callerProjectId };
  }
  return { kind: 'project-member', projectId: callerProjectId };
}

export function authorizeThreadAccess(
  caller: CoordinationRole,
  targetProjectId: string | undefined,
  elevatedProjectId?: string,
): boolean {
  if (caller.kind === 'portfolio') {
    return targetProjectId === undefined || targetProjectId === elevatedProjectId;
  }
  if (caller.kind === 'unassigned') return targetProjectId === undefined;
  return targetProjectId === caller.projectId;
}

export function canWriteManagerNotes(caller: CoordinationRole, targetProjectId: string | undefined): boolean {
  if (caller.kind === 'portfolio') return targetProjectId === undefined;
  return caller.kind === 'project-orchestrator' && targetProjectId === caller.projectId;
}

export function assertProposalOwnership(
  existing: { sourceThreadId?: string } | undefined,
  callerThreadId: string,
): void {
  if (existing && existing.sourceThreadId !== callerThreadId) {
    throw new Error('A proposed reply from another orchestrator is already pending. Clear it first.');
  }
}

export function repairStaleProjectOrchestrators(
  projects: OrchestratedProjectRef[],
  threadProjectId: (threadId: string) => string | undefined,
  scheduledItems: Array<{ isOrchestratorHeartbeat?: boolean; targetThreadId?: string }>,
  portfolioOrchestratorThreadId?: string,
): boolean {
  let changed = false;
  for (const project of projects) {
    if (project.orchestratorEnabled === undefined) {
      project.orchestratorEnabled = true;
      changed = true;
    }
    if (project.orchestratorThreadId && threadProjectId(project.orchestratorThreadId) !== project.id) {
      project.orchestratorThreadId = undefined;
      changed = true;
    }
  }
  const validIds = new Set([portfolioOrchestratorThreadId, ...projects.map(project => project.orchestratorThreadId)].filter(Boolean));
  for (let index = scheduledItems.length - 1; index >= 0; index--) {
    const item = scheduledItems[index]!;
    if (item.isOrchestratorHeartbeat && item.targetThreadId && !validIds.has(item.targetThreadId)) {
      scheduledItems.splice(index, 1);
      changed = true;
    }
  }
  return changed;
}

import { describe, expect, it } from 'vitest';
import { assertProposalOwnership, authorizeThreadAccess, repairStaleProjectOrchestrators, resolveCoordinationRole } from '../../src/coordinationScope';

const projects = [
  { id: 'project-a', orchestratorThreadId: 'orch-a' },
  { id: 'project-b', orchestratorThreadId: 'orch-b' },
];

describe('coordination scope', () => {
  it('resolves portfolio, project orchestrator, project member, and unassigned roles', () => {
    expect(resolveCoordinationRole('portfolio', 'portfolio', undefined, projects)).toEqual({ kind: 'portfolio' });
    expect(resolveCoordinationRole('orch-a', 'portfolio', 'project-a', projects)).toEqual({ kind: 'project-orchestrator', projectId: 'project-a' });
    expect(resolveCoordinationRole('worker-a', 'portfolio', 'project-a', projects)).toEqual({ kind: 'project-member', projectId: 'project-a' });
    expect(resolveCoordinationRole('loose', 'portfolio', undefined, projects)).toEqual({ kind: 'unassigned' });
  });

  it('allows project callers only within their own project', () => {
    const caller = { kind: 'project-orchestrator' as const, projectId: 'project-a' };
    expect(authorizeThreadAccess(caller, 'project-a')).toBe(true);
    expect(authorizeThreadAccess(caller, 'project-b')).toBe(false);
    expect(authorizeThreadAccess(caller, undefined)).toBe(false);
  });

  it('requires per-call elevation for portfolio cross-project access', () => {
    const caller = { kind: 'portfolio' as const };
    expect(authorizeThreadAccess(caller, undefined)).toBe(true);
    expect(authorizeThreadAccess(caller, 'project-a')).toBe(false);
    expect(authorizeThreadAccess(caller, 'project-a', 'project-a')).toBe(true);
    expect(authorizeThreadAccess(caller, 'project-a', 'project-b')).toBe(false);
  });

  it('keeps ordinary unassigned callers within unassigned threads', () => {
    const caller = { kind: 'unassigned' as const };
    expect(authorizeThreadAccess(caller, undefined)).toBe(true);
    expect(authorizeThreadAccess(caller, 'project-a')).toBe(false);
  });

  it('treats legacy proposals without provenance as owned collisions', () => {
    expect(() => assertProposalOwnership({ text: 'legacy', generatedAt: 1 }, 'orch-a')).toThrow(/another orchestrator/);
    expect(() => assertProposalOwnership({ text: 'mine', generatedAt: 1, sourceThreadId: 'orch-a' }, 'orch-a')).not.toThrow();
  });

  it('repairs stale Project references and orphan heartbeats in one startup pass', () => {
    const mutableProjects = [{ id: 'a', orchestratorThreadId: 'stale', orchestratorEnabled: false }, { id: 'b', orchestratorThreadId: 'orch-b' }];
    const items = [
      { isOrchestratorHeartbeat: true, targetThreadId: 'stale' },
      { isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' },
    ];
    expect(repairStaleProjectOrchestrators(mutableProjects, id => id === 'orch-b' ? 'b' : undefined, items, 'portfolio')).toBe(true);
    expect(mutableProjects[0]!.orchestratorThreadId).toBeUndefined();
    expect(mutableProjects[0]!.orchestratorEnabled).toBe(false);
    expect(mutableProjects[1]!.orchestratorEnabled).toBe(true);
    expect(items).toEqual([{ isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' }]);
  });

  it('migrates legacy Projects to enabled and preserves persisted disabled state across reloads', () => {
    const serialized = JSON.stringify([
      { id: 'legacy', createdAt: 1 },
      { id: 'disabled', createdAt: 2, orchestratorEnabled: false },
    ]);
    const reloaded = JSON.parse(serialized) as Array<{ id: string; orchestratorEnabled?: boolean }>;

    expect(repairStaleProjectOrchestrators(reloaded, () => undefined, [], undefined)).toBe(true);
    expect(reloaded).toEqual([
      { id: 'legacy', createdAt: 1, orchestratorEnabled: true },
      { id: 'disabled', createdAt: 2, orchestratorEnabled: false },
    ]);
  });

  it('removes standalone orphan heartbeats even when every Project reference is valid', () => {
    const mutableProjects = [{ id: 'b', orchestratorThreadId: 'orch-b' }];
    const items = [
      { isOrchestratorHeartbeat: true, targetThreadId: 'orphan' },
      { isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' },
    ];
    expect(repairStaleProjectOrchestrators(mutableProjects, () => 'b', items, 'portfolio')).toBe(true);
    expect(items).toEqual([{ isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' }]);
  });

  it('returns false when references and heartbeat targets are already valid', () => {
    const mutableProjects = [{ id: 'b', orchestratorThreadId: 'orch-b' }];
    const items = [{ isOrchestratorHeartbeat: true, targetThreadId: 'orch-b' }];
    expect(repairStaleProjectOrchestrators(mutableProjects, () => 'b', items, 'portfolio')).toBe(false);
  });
});

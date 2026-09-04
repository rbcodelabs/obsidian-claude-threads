import { describe, it, expect } from 'vitest';
import {
  describeOrchestratorThread,
  isOrchestratorThread,
  listOrchestratorThreadIds,
  orchestratorWarning,
  type OrchestratorContext,
} from '../../src/orchestratorThreads';

/**
 * The orchestrator predicate used to be four inline copies. These lock in the
 * behavior of the shared helper — including the warning copy, which must stay
 * character-for-character identical to what ThreadsView.closeThread has always
 * shown, since users read it before deleting an orchestrator.
 */

const CTX: OrchestratorContext = {
  portfolioThreadId: 'portfolio',
  projects: [
    { id: 'p1', name: 'Agentic PM Playbook' },
    { id: 'p2', name: 'Golden Wealth', orchestratorThreadId: 'orch-p2' },
  ],
};

describe('describeOrchestratorThread', () => {
  it('identifies the Portfolio orchestrator', () => {
    expect(describeOrchestratorThread('portfolio', CTX)).toEqual({ kind: 'portfolio' });
  });

  it('identifies a Project orchestrator and carries the Project name for the warning', () => {
    expect(describeOrchestratorThread('orch-p2', CTX)).toEqual({
      kind: 'project',
      projectId: 'p2',
      projectName: 'Golden Wealth',
    });
  });

  it('returns null for an ordinary thread', () => {
    expect(describeOrchestratorThread('t1', CTX)).toBeNull();
  });

  it('returns null when no Portfolio orchestrator is configured, even for an empty id', () => {
    const ctx: OrchestratorContext = { portfolioThreadId: undefined, projects: [] };
    expect(describeOrchestratorThread('', ctx)).toBeNull();
    expect(describeOrchestratorThread('anything', ctx)).toBeNull();
  });

  it('prefers the Project role when a thread is somehow both, matching closeThread', () => {
    const ctx: OrchestratorContext = {
      portfolioThreadId: 'both',
      projects: [{ id: 'p9', name: 'HipTrip', orchestratorThreadId: 'both' }],
    };
    expect(describeOrchestratorThread('both', ctx)).toEqual({
      kind: 'project',
      projectId: 'p9',
      projectName: 'HipTrip',
    });
  });
});

describe('isOrchestratorThread', () => {
  it('is true for both kinds and false otherwise', () => {
    expect(isOrchestratorThread('portfolio', CTX)).toBe(true);
    expect(isOrchestratorThread('orch-p2', CTX)).toBe(true);
    expect(isOrchestratorThread('t1', CTX)).toBe(false);
  });
});

describe('listOrchestratorThreadIds', () => {
  it('lists the portfolio first, then Project orchestrators, skipping Projects without one', () => {
    expect(listOrchestratorThreadIds(CTX)).toEqual(['portfolio', 'orch-p2']);
  });

  it('de-duplicates a thread that is both', () => {
    expect(listOrchestratorThreadIds({
      portfolioThreadId: 'both',
      projects: [{ id: 'p9', name: 'HipTrip', orchestratorThreadId: 'both' }],
    })).toEqual(['both']);
  });

  it('is empty when nothing is configured', () => {
    expect(listOrchestratorThreadIds({ portfolioThreadId: undefined, projects: [] })).toEqual([]);
  });
});

describe('orchestratorWarning', () => {
  it('matches the shipped Portfolio copy character-for-character', () => {
    expect(orchestratorWarning({ kind: 'portfolio' })).toBe(
      'This is your Portfolio Orchestrator. Deleting it stops portfolio review until you run "Open Portfolio Orchestrator" again to create a new one.',
    );
  });

  it('matches the shipped Project copy character-for-character', () => {
    expect(orchestratorWarning({ kind: 'project', projectId: 'p2', projectName: 'Golden Wealth' })).toBe(
      'This is the Golden Wealth Project Orchestrator. Deleting it stops automatic Project review until it is recreated.',
    );
  });
});

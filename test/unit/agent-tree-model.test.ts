import { describe, expect, it } from 'vitest';
import {
  ACTIVE_AGENT_STATUSES,
  agentLabel,
  agentSubLabel,
  buildAgentBreadcrumbs,
  flattenAgentTree,
  summarizeAgentTeam,
} from '../../src/agentRuns/agentTreeModel';
import type { AgentRun } from '../../src/types';

const run = (overrides: Partial<AgentRun> & { id: string }): AgentRun => ({
  threadId: 't',
  nativeAgentId: `native-${overrides.id}`,
  harness: 'claude',
  description: 'Review code',
  status: 'working',
  startedAt: 1,
  updatedAt: 2,
  capabilities: { viewTranscript: true, sendMessage: false, interrupt: false },
  events: [],
  ...overrides,
});

describe('ACTIVE_AGENT_STATUSES', () => {
  it('matches the set ThreadManager treats as live background work', () => {
    expect([...ACTIVE_AGENT_STATUSES].sort()).toEqual(['starting', 'waiting', 'working']);
    expect(ACTIVE_AGENT_STATUSES.has('completed')).toBe(false);
    expect(ACTIVE_AGENT_STATUSES.has('unavailable')).toBe(false);
  });
});

describe('flattenAgentTree', () => {
  it('emits depth-first pre-order rows with 1-based levels', () => {
    const rows = flattenAgentTree([
      run({ id: 'a' }),
      run({ id: 'b', parentAgentRunId: 'a' }),
      run({ id: 'c', parentAgentRunId: 'b' }),
      run({ id: 'd' }),
    ]);
    expect(rows.map(r => [r.run.id, r.level])).toEqual([
      ['a', 1], ['b', 2], ['c', 3], ['d', 1],
    ]);
  });

  it('promotes orphans whose parent is not in the thread to roots', () => {
    const rows = flattenAgentTree([run({ id: 'a', parentAgentRunId: 'gone' })]);
    expect(rows).toEqual([{ run: expect.objectContaining({ id: 'a' }), level: 1 }]);
  });

  it('terminates on a self-parenting run instead of hanging', () => {
    const rows = flattenAgentTree([run({ id: 'a', parentAgentRunId: 'a' })]);
    expect(rows.map(r => [r.run.id, r.level])).toEqual([['a', 1]]);
  });

  it('terminates on a two-node parent cycle and still renders both agents', () => {
    const rows = flattenAgentTree([
      run({ id: 'a', parentAgentRunId: 'b' }),
      run({ id: 'b', parentAgentRunId: 'a' }),
    ]);
    expect(rows.map(r => r.run.id).sort()).toEqual(['a', 'b']);
    expect(rows).toHaveLength(2);
  });

  it('terminates on a three-node cycle without dropping or duplicating rows', () => {
    const rows = flattenAgentTree([
      run({ id: 'a', parentAgentRunId: 'c' }),
      run({ id: 'b', parentAgentRunId: 'a' }),
      run({ id: 'c', parentAgentRunId: 'b' }),
    ]);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(r => r.run.id))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns nothing for an empty team', () => {
    expect(flattenAgentTree([])).toEqual([]);
  });
});

describe('summarizeAgentTeam', () => {
  it('reports zero agents', () => {
    expect(summarizeAgentTeam([])).toMatchObject({ total: 0, active: 0, label: 'No agents', tone: 'idle' });
  });

  it('counts starting, working and waiting as active', () => {
    const summary = summarizeAgentTeam([
      run({ id: 'a', status: 'starting' }),
      run({ id: 'b', status: 'working' }),
      run({ id: 'c', status: 'waiting' }),
      run({ id: 'd', status: 'completed' }),
    ]);
    expect(summary).toMatchObject({ total: 4, active: 3, label: '3 agents working', tone: 'active' });
  });

  it('singularizes a lone active agent', () => {
    expect(summarizeAgentTeam([run({ id: 'a' })]).label).toBe('1 agent working');
  });

  it('surfaces failures once nothing is active', () => {
    expect(summarizeAgentTeam([run({ id: 'a', status: 'failed' })])).toMatchObject({
      label: '1 agent failed', tone: 'failed',
    });
  });

  it('keeps crash-restored unavailable agents visible as a plain count', () => {
    expect(summarizeAgentTeam([
      run({ id: 'a', status: 'unavailable' }),
      run({ id: 'b', status: 'unavailable' }),
    ])).toMatchObject({ total: 2, active: 0, label: '2 agents', tone: 'idle' });
  });

  it('marks an all-completed team as done', () => {
    expect(summarizeAgentTeam([run({ id: 'a', status: 'completed' })]).tone).toBe('done');
  });
});

describe('agentLabel / agentSubLabel', () => {
  it('prefers the role', () => {
    expect(agentLabel(run({ id: 'a', role: 'reviewer', description: 'Review auth' }))).toBe('reviewer');
  });

  it('falls back to the description when there is no role', () => {
    expect(agentLabel(run({ id: 'a', description: 'Review auth' }))).toBe('Review auth');
  });

  it('demotes generic Codex placeholder descriptions out of the label slot', () => {
    const codex = run({ id: 'a', harness: 'codex', description: 'Codex sub-agent 0f21' });
    expect(agentLabel(codex)).toBe('Sub-agent');
    expect(agentSubLabel(codex)).toBe('Codex sub-agent 0f21');
  });

  it('prefers currentActivity for the second line', () => {
    const codex = run({ id: 'a', harness: 'codex', description: 'Codex subagent 0f21', currentActivity: 'Reading tests' });
    expect(agentSubLabel(codex)).toBe('Reading tests');
  });

  it('falls back to the status when there is nothing else to say', () => {
    expect(agentSubLabel(run({ id: 'a', role: 'reviewer', description: 'reviewer', status: 'completed' }))).toBe('completed');
  });
});

describe('buildAgentBreadcrumbs', () => {
  it('returns the root-to-selected chain', () => {
    const runs = [
      run({ id: 'a' }),
      run({ id: 'b', parentAgentRunId: 'a' }),
      run({ id: 'c', parentAgentRunId: 'b' }),
    ];
    expect(buildAgentBreadcrumbs(runs, 'c').map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing when nothing is selected or the selection is stale', () => {
    expect(buildAgentBreadcrumbs([run({ id: 'a' })], undefined)).toEqual([]);
    expect(buildAgentBreadcrumbs([run({ id: 'a' })], 'gone')).toEqual([]);
  });

  it('terminates on a self-parenting run', () => {
    expect(buildAgentBreadcrumbs([run({ id: 'a', parentAgentRunId: 'a' })], 'a').map(r => r.id)).toEqual(['a']);
  });

  it('terminates on a parent cycle', () => {
    const runs = [
      run({ id: 'a', parentAgentRunId: 'b' }),
      run({ id: 'b', parentAgentRunId: 'a' }),
    ];
    expect(buildAgentBreadcrumbs(runs, 'a').map(r => r.id)).toEqual(['b', 'a']);
  });
});

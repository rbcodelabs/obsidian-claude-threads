import { describe, expect, it } from 'vitest';
import type { Thread } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/types';
import {
  groupDashboardThreads,
  normalizeAgentsGroupBy,
  toggleAgentsGrouping,
  type DashboardProjectGroup,
} from '../../src/dashboardProjectGroups';

function thread(id: string): Thread {
  return { id, title: id, cwd: '/tmp', messages: [], createdAt: 1, updatedAt: 1 } as Thread;
}

describe('dashboard project-first grouping', () => {
  it('sorts projects alphabetically and keeps Unassigned last', () => {
    const groups = groupDashboardThreads(
      [thread('u'), thread('h'), thread('c')],
      (item): Omit<DashboardProjectGroup, 'threads'> => item.id === 'u'
        ? { key: 'unassigned', label: 'Unassigned' }
        : item.id === 'h'
          ? { key: 'project:h', label: 'HipTrip' }
          : { key: 'project:c', label: 'Claude Threads' },
    );

    expect(groups.map(group => group.label)).toEqual(['Claude Threads', 'HipTrip', 'Unassigned']);
    expect(groups.map(group => group.threads.map(item => item.id))).toEqual([['c'], ['h'], ['u']]);
  });

  it('sorts threads within a project by recency', () => {
    const old = { ...thread('old'), updatedAt: 1 };
    const fresh = { ...thread('fresh'), updatedAt: 3 };
    const middle = { ...thread('middle'), updatedAt: 2 };
    const [group] = groupDashboardThreads(
      [old, fresh, middle],
      (): Omit<DashboardProjectGroup, 'threads'> => ({ key: 'project:p', label: 'Project' }),
    );
    expect(group.threads.map(item => item.id)).toEqual(['fresh', 'middle', 'old']);
  });
});

describe('dashboard grouping preference', () => {
  it('normalizes missing and invalid values to the backward-compatible combined mode', () => {
    expect(DEFAULT_SETTINGS.agentsGroupBy).toBe('project-status');
    expect(normalizeAgentsGroupBy(undefined)).toBe('project-status');
    expect(normalizeAgentsGroupBy('unexpected')).toBe('project-status');
  });

  it('supports project-only, status-only, and combined modes', () => {
    expect(toggleAgentsGrouping('project-status', 'status')).toBe('project');
    expect(toggleAgentsGrouping('project-status', 'project')).toBe('status');
    expect(toggleAgentsGrouping('project', 'status')).toBe('project-status');
    expect(toggleAgentsGrouping('status', 'project')).toBe('project-status');
  });

  it('does not disable the last active grouping', () => {
    expect(toggleAgentsGrouping('project', 'project')).toBe('project');
    expect(toggleAgentsGrouping('status', 'status')).toBe('status');
  });
});

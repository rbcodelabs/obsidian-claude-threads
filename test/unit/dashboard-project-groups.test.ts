import { describe, expect, it } from 'vitest';
import type { Thread } from '../../src/types';
import { groupDashboardThreads, type DashboardProjectGroup } from '../../src/dashboardProjectGroups';

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
});

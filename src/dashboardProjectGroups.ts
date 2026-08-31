import type { Thread } from './types';

export interface DashboardProjectGroup {
  key: string;
  label: string;
  threads: Thread[];
}

export function groupDashboardThreads(
  threads: Thread[],
  resolveGroup: (thread: Thread) => Omit<DashboardProjectGroup, 'threads'>,
): DashboardProjectGroup[] {
  const groups = new Map<string, DashboardProjectGroup>();
  for (const thread of threads) {
    const identity = resolveGroup(thread);
    const current = groups.get(identity.key);
    if (current) current.threads.push(thread);
    else groups.set(identity.key, { ...identity, threads: [thread] });
  }
  return Array.from(groups.values()).sort((a, b) => {
    if (a.key === 'unassigned') return 1;
    if (b.key === 'unassigned') return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
  });
}

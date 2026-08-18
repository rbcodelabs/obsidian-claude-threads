import type { AgentRun } from '../types';

export interface AgentStatusCounts { active: number; completed: number; failed: number }

export function agentStatusCounts(runs: AgentRun[]): AgentStatusCounts {
  return runs.reduce((counts, run) => {
    if (run.status === 'starting' || run.status === 'working') counts.active++;
    else if (run.status === 'completed') counts.completed++;
    else if (run.status === 'failed' || run.status === 'interrupted') counts.failed++;
    return counts;
  }, { active: 0, completed: 0, failed: 0 });
}

export function buildAgentConversation(runs: AgentRun[], selectedId: string) {
  const byId = new Map(runs.map(run => [run.id, run]));
  const selected = byId.get(selectedId);
  if (!selected) return undefined;
  const chain: AgentRun[] = [];
  let cursor: AgentRun | undefined = selected;
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentAgentRunId ? byId.get(cursor.parentAgentRunId) : undefined;
  }
  const hasTranscript = selected.capabilities.viewTranscript && !!selected.transcript?.length;
  return {
    run: selected,
    kind: hasTranscript ? 'transcript' as const : 'activity' as const,
    title: hasTranscript ? 'Agent conversation' : 'Agent activity',
    breadcrumbs: [
      { label: 'Main conversation', agentRunId: undefined as string | undefined },
      ...chain.map(run => ({ label: run.role ?? run.description, agentRunId: run.id })),
    ],
  };
}

export function renderAgentStatusPill(button: HTMLButtonElement, runs: AgentRun[]): void {
  button.replaceChildren();
  button.hidden = runs.length === 0;
  if (!runs.length) return;
  const counts = agentStatusCounts(runs);
  const label = `View agent team: ${counts.active} active, ${counts.completed} completed${counts.failed ? `, ${counts.failed} needs attention` : ''}`;
  button.className = 'ct-agent-status-pill';
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  const add = (cls: string, icon: string, count: number) => {
    if (!count && cls !== 'ct-agent-status-completed') return;
    const item = document.createElement('span'); item.className = `ct-agent-status-item ${cls}`;
    const mark = document.createElement('span'); mark.className = 'ct-agent-status-mark'; mark.setAttribute('aria-hidden', 'true'); mark.textContent = icon;
    const value = document.createElement('span'); value.textContent = String(count);
    item.append(mark, value); button.append(item);
  };
  const agent = document.createElement('span'); agent.className = 'ct-agent-status-icon'; agent.setAttribute('aria-hidden', 'true'); agent.textContent = '◉'; button.append(agent);
  add('ct-agent-status-active', '◌', counts.active);
  add('ct-agent-status-completed', '✓', counts.completed);
  add('ct-agent-status-failed', '!', counts.failed);
}

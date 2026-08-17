import type { AgentRun } from '../types';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderAgentTeam(host: HTMLElement, runs: AgentRun[], onSelect: (id: string) => void, selectedId?: string): void {
  host.replaceChildren();
  if (!runs.length) { host.classList.add('ct-hidden'); return; }
  host.classList.remove('ct-hidden');
  const byId = new Map(runs.map(run => [run.id, run]));
  const children = new Map<string | undefined, AgentRun[]>();
  for (const run of runs) {
    const parent = run.parentAgentRunId && byId.has(run.parentAgentRunId) ? run.parentAgentRunId : undefined;
    const bucket = children.get(parent) ?? []; bucket.push(run); children.set(parent, bucket);
  }

  const header = el('div', 'ct-agent-team-header');
  header.append(el('strong', '', 'Agent Team'), el('span', 'ct-agent-team-count', `${runs.filter(r => r.status === 'working' || r.status === 'starting').length} active`));
  host.append(header);
  const tree = el('div', 'ct-agent-tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'Native agent team');
  const append = (parent: HTMLElement, parentId: string | undefined, level: number) => {
    for (const run of children.get(parentId) ?? []) {
      const row = el('div', `ct-agent-row ct-agent-${run.status}`);
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(level)); row.dataset.agentRunId = run.id;
      const button = el('button', 'ct-agent-row-button') as HTMLButtonElement;
      button.type = 'button'; button.setAttribute('aria-label', `View agent ${run.role ?? run.description}`);
      button.append(el('span', 'ct-agent-status-dot'), el('span', 'ct-agent-role', run.role ?? 'agent'), el('span', 'ct-agent-description', run.description), el('span', 'ct-agent-state', run.status));
      button.addEventListener('click', () => onSelect(run.id)); row.append(button); parent.append(row);
      append(row, run.id, level + 1);
    }
  };
  append(tree, undefined, 1); host.append(tree);

  const selected = selectedId ? byId.get(selectedId) : undefined;
  if (!selected) return;
  const detail = el('section', 'ct-agent-detail'); detail.setAttribute('aria-label', `Agent detail: ${selected.description}`);
  const crumbs: string[] = [];
  let cursor: AgentRun | undefined = selected;
  while (cursor) { crumbs.unshift(cursor.role ?? cursor.description); cursor = cursor.parentAgentRunId ? byId.get(cursor.parentAgentRunId) : undefined; }
  crumbs.unshift('main');
  detail.append(el('div', 'ct-agent-breadcrumbs', crumbs.join(' › ')), el('h3', '', selected.description));
  const meta = el('div', 'ct-agent-meta', `${selected.harness} · ${selected.status}${selected.model ? ` · ${selected.model}` : ''}`); detail.append(meta);
  const timeline = el('ol', 'ct-agent-timeline');
  for (const event of [...selected.events].sort((a, b) => a.timestamp - b.timestamp)) {
    const item = el('li', `ct-agent-event ct-agent-event-${event.kind}`);
    item.append(el('time', '', new Date(event.timestamp).toLocaleTimeString()), el('span', '', `${event.toolName ? `${event.toolName}: ` : ''}${event.text}`)); timeline.append(item);
  }
  if (!selected.events.length) timeline.append(el('li', 'ct-agent-event-empty', 'No detailed activity has been exposed by the harness yet.'));
  detail.append(timeline);
  if (!selected.capabilities.sendMessage && !selected.capabilities.interrupt) detail.append(el('p', 'ct-agent-capability-note', 'Direct messaging and single-agent interruption are not exposed by this harness.'));
  host.append(detail);
}

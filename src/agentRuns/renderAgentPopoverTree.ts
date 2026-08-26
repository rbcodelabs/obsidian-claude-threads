import type { AgentRun } from '../types';
import { agentLabel, agentSubLabel, flattenAgentTree } from './agentTreeModel';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Renders the agent tree as flat rows inside the composer popover.
 *
 * Nesting is expressed with `aria-level` plus a `--ct-agent-level` custom property
 * that CSS turns into padding, rather than nested DOM. Flat rows are what keep a
 * deep tree from overflowing horizontally at 375px, and they let the whole list be
 * one roving-focus group for arrow-key navigation.
 */
export function renderAgentPopoverTree(
  host: HTMLElement,
  runs: AgentRun[],
  onSelect: (id: string) => void,
  selectedId?: string,
): void {
  host.replaceChildren();
  host.setAttribute('role', 'tree');
  host.setAttribute('aria-label', 'Sub-agents in this thread');

  const rows = flattenAgentTree(runs);
  if (!rows.length) {
    host.append(el('div', 'ct-agent-popover-empty', 'No sub-agents have started in this thread yet.'));
    return;
  }

  for (const { run, level } of rows) {
    const row = el('div', `ct-agent-row ct-agent-${run.status}`);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(level));
    row.dataset.agentRunId = run.id;

    const button = el('button', 'ct-agent-row-button') as HTMLButtonElement;
    button.type = 'button';
    // Cap the visual indent so a deeply nested team still fits a narrow phone.
    button.style.setProperty('--ct-agent-level', String(Math.min(level - 1, 4)));
    const isSelected = run.id === selectedId;
    if (isSelected) button.classList.add('ct-agent-row-selected');
    button.setAttribute('aria-current', isSelected ? 'true' : 'false');
    button.setAttribute('aria-label', `View activity for ${agentLabel(run)} (${run.status})`);
    button.append(
      el('span', 'ct-agent-status-dot'),
      el('span', 'ct-agent-role', agentLabel(run)),
      el('span', 'ct-agent-description', agentSubLabel(run)),
      el('span', 'ct-agent-state', run.status),
    );
    button.addEventListener('click', () => onSelect(run.id));
    row.append(button);
    host.append(row);
  }
}

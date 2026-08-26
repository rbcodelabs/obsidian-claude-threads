import type { AgentRun } from '../types';
import { agentLabel } from './agentTreeModel';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Renders one agent's activity timeline into the message pane.
 *
 * Deliberately owns no breadcrumb of its own: the breadcrumb lives in the sticky
 * `.ct-agent-view-header` above it, because that header must stay pinned while
 * this body scrolls.
 */
export function renderAgentActivity(host: HTMLElement, run: AgentRun): void {
  host.replaceChildren();
  host.setAttribute('aria-label', `Agent activity: ${run.description}`);

  host.append(el('h3', 'ct-agent-activity-title', run.description || agentLabel(run)));
  host.append(el(
    'div',
    'ct-agent-meta',
    `${run.harness} · ${run.status}${run.model ? ` · ${run.model}` : ''}`,
  ));

  const timeline = el('ol', 'ct-agent-timeline');
  for (const event of [...run.events].sort((a, b) => a.timestamp - b.timestamp)) {
    const item = el('li', `ct-agent-event ct-agent-event-${event.kind}`);
    item.append(
      el('time', '', new Date(event.timestamp).toLocaleTimeString()),
      el('span', '', `${event.toolName ? `${event.toolName}: ` : ''}${event.text}`),
    );
    timeline.append(item);
  }
  if (!run.events.length) {
    timeline.append(el('li', 'ct-agent-event-empty', 'No detailed activity has been exposed by the harness yet.'));
  }
  host.append(timeline);

  if (run.error) host.append(el('p', 'ct-agent-error-note', run.error));
  if (!run.capabilities.sendMessage && !run.capabilities.interrupt) {
    host.append(el('p', 'ct-agent-capability-note', 'Direct messaging and single-agent interruption are not exposed by this harness.'));
  }
}

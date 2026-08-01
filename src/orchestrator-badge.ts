import { setIcon, setTooltip } from 'obsidian';

/**
 * Appends a small "bot" icon badge to `parent` when `threadId` is the thread
 * running the bundled orchestrator skill (settings.orchestratorThreadId).
 * No-op when the IDs don't match or no orchestrator thread has been created yet.
 */
export function appendOrchestratorBadge(
  parent: HTMLElement,
  threadId: string,
  orchestratorThreadId: string | undefined,
): void {
  if (threadId !== orchestratorThreadId) return;
  const badge = parent.createSpan({ cls: 'ct-orchestrator-badge' });
  setIcon(badge, 'bot');
  setTooltip(badge, 'Thread Orchestrator');
}

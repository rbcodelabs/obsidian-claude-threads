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
  projectOrchestratorThreadId?: string,
): void {
  const isPortfolio = threadId === orchestratorThreadId;
  const isProject = threadId === projectOrchestratorThreadId;
  if (!isPortfolio && !isProject) return;
  const badge = parent.createSpan({ cls: `ct-orchestrator-badge ${isProject ? 'ct-project-orchestrator-badge' : 'ct-portfolio-orchestrator-badge'}` });
  setIcon(badge, 'bot');
  setTooltip(badge, isProject ? 'Project Orchestrator' : 'Portfolio Orchestrator');
}

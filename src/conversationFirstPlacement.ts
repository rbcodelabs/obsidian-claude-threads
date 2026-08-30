import type { WorkspaceLeaf, WorkspaceRoot, WorkspaceSidedock } from 'obsidian';
import type { PluginSettings } from './types';

export interface ConversationFirstChatPlan {
  keep: WorkspaceLeaf | null;
  detach: WorkspaceLeaf[];
  activeThreadId?: string;
}

export function isConversationFirstPlacement(
  placement: PluginSettings['threadViewPlacement'],
  isMobile: boolean,
): boolean {
  return !isMobile && placement === 'conversation-first';
}

function activeThreadIdFrom(leaf: WorkspaceLeaf | undefined): string | undefined {
  const state = leaf?.view.getState() as { activeThreadId?: unknown } | undefined;
  return typeof state?.activeThreadId === 'string' ? state.activeThreadId : undefined;
}

/** Compute an idempotent singleton migration without mutating the workspace. */
export function planConversationFirstChat(
  chatLeaves: WorkspaceLeaf[],
  rootSplit: WorkspaceRoot,
): ConversationFirstChatPlan {
  const keep = chatLeaves.find((leaf) => leaf.getRoot() === rootSplit) ?? null;
  const stateSource = keep ?? chatLeaves[0];
  return {
    keep,
    detach: keep ? chatLeaves.filter((leaf) => leaf !== keep) : chatLeaves,
    activeThreadId: activeThreadIdFrom(stateSource),
  };
}

/** Apply a conversation-first plan without removing the last working chat prematurely. */
export async function activateConversationFirstChat(
  plan: ConversationFirstChatPlan,
  createDestination: () => WorkspaceLeaf | null,
  viewType: string,
): Promise<WorkspaceLeaf> {
  if (plan.keep) {
    for (const duplicate of plan.detach) duplicate.detach();
    return plan.keep;
  }

  const destination = createDestination();
  if (!destination) throw new Error('Unable to create a main-area leaf for Claude Threads.');
  await destination.setViewState({
    type: viewType,
    active: true,
    state: plan.activeThreadId ? { activeThreadId: plan.activeThreadId } : {},
  });
  for (const source of plan.detach) source.detach();
  return destination;
}

/** Restore classic placement while preserving either historical sidebar. */
export function planClassicChat(
  chatLeaves: WorkspaceLeaf[],
  leftSplit: WorkspaceSidedock,
  rightSplit: WorkspaceSidedock,
): ConversationFirstChatPlan {
  const keep = chatLeaves.find((leaf) => {
    const root = leaf.getRoot();
    return root === leftSplit || root === rightSplit;
  }) ?? null;
  const stateSource = keep ?? chatLeaves[0];
  return {
    keep,
    detach: keep ? chatLeaves.filter((leaf) => leaf !== keep) : chatLeaves,
    activeThreadId: activeThreadIdFrom(stateSource),
  };
}

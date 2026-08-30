import type { WorkspaceLeaf, WorkspaceRoot } from 'obsidian';

export interface ConversationFirstChatPlan {
  keep: WorkspaceLeaf | null;
  detach: WorkspaceLeaf[];
  activeThreadId?: string;
}

/** Compute an idempotent singleton migration without mutating the workspace. */
export function planConversationFirstChat(
  chatLeaves: WorkspaceLeaf[],
  rootSplit: WorkspaceRoot,
): ConversationFirstChatPlan {
  const keep = chatLeaves.find((leaf) => leaf.getRoot() === rootSplit) ?? null;
  const stateSource = keep ?? chatLeaves[0];
  const state = stateSource?.view.getState() as { activeThreadId?: unknown } | undefined;
  const activeThreadId = typeof state?.activeThreadId === 'string' ? state.activeThreadId : undefined;
  return {
    keep,
    detach: keep ? chatLeaves.filter((leaf) => leaf !== keep) : chatLeaves,
    activeThreadId,
  };
}

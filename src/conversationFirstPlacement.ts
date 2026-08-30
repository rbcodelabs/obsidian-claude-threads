import type { WorkspaceLeaf } from 'obsidian';
import type { PluginSettings } from './types';

export type ConversationPlacement = PluginSettings['threadViewPlacement'];

export interface ConversationFirstChatPlan {
  keep: WorkspaceLeaf | null;
  detach: WorkspaceLeaf[];
  activeThreadId?: string;
}

interface PersistedChatState {
  activeThreadId?: unknown;
  conversationPlacement?: unknown;
}

export function isConversationFirstPlacement(placement: ConversationPlacement, isMobile: boolean): boolean {
  return !isMobile && placement === 'conversation-first';
}

function stateFrom(leaf: WorkspaceLeaf | undefined): PersistedChatState {
  return (leaf?.view.getState() ?? {}) as PersistedChatState;
}

function activeThreadIdFrom(leaf: WorkspaceLeaf | undefined): string | undefined {
  const activeThreadId = stateFrom(leaf).activeThreadId;
  return typeof activeThreadId === 'string' ? activeThreadId : undefined;
}

function planMarkedChat(chatLeaves: WorkspaceLeaf[], placement: ConversationPlacement): ConversationFirstChatPlan {
  const keep = chatLeaves.find((leaf) => stateFrom(leaf).conversationPlacement === placement) ?? null;
  const stateSource = keep ?? chatLeaves[0];
  return {
    keep,
    detach: keep ? chatLeaves.filter((leaf) => leaf !== keep) : chatLeaves,
    activeThreadId: activeThreadIdFrom(stateSource),
  };
}

/** Geode intentionally exposes no rootSplit/getRoot tree protocol, so placement is plugin-owned view state. */
export function planConversationFirstChat(chatLeaves: WorkspaceLeaf[]): ConversationFirstChatPlan {
  return planMarkedChat(chatLeaves, 'conversation-first');
}

export function planClassicChat(chatLeaves: WorkspaceLeaf[]): ConversationFirstChatPlan {
  const marked = planMarkedChat(chatLeaves, 'classic');
  if (marked.keep || chatLeaves.length !== 1) return marked;
  // Pre-feature installs have one unmarked sidebar leaf. Preserve that legacy default.
  if (stateFrom(chatLeaves[0]).conversationPlacement === undefined) {
    return { keep: chatLeaves[0], detach: [], activeThreadId: activeThreadIdFrom(chatLeaves[0]) };
  }
  return marked;
}

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
    state: {
      ...(plan.activeThreadId ? { activeThreadId: plan.activeThreadId } : {}),
      conversationPlacement: 'conversation-first',
    },
  });
  for (const source of plan.detach) source.detach();
  return destination;
}

export async function persistActiveThreadSelection(
  workspace: { requestSaveLayout?: () => unknown },
  settings: { activeThreadId?: string },
  saveSettings: () => Promise<void>,
  activeThreadId: string,
): Promise<void> {
  settings.activeThreadId = activeThreadId;
  workspace.requestSaveLayout?.();
  await saveSettings();
}

export function resolvePersistedActiveThread(
  viewStateId: string | null,
  settingsId: string | undefined,
  exists: (id: string) => boolean,
  fallbackId: string,
): string {
  if (viewStateId && exists(viewStateId)) return viewStateId;
  if (settingsId && exists(settingsId)) return settingsId;
  return fallbackId;
}

export async function transitionConversationPlacement(
  settings: { threadViewPlacement: ConversationPlacement },
  next: ConversationPlacement,
  activateView: () => Promise<void>,
  saveSettings: () => Promise<void>,
): Promise<void> {
  const previous = settings.threadViewPlacement;
  let migrationSucceeded = false;
  settings.threadViewPlacement = next;
  try {
    await activateView();
    migrationSucceeded = true;
    await saveSettings();
  } catch (error) {
    settings.threadViewPlacement = previous;
    try {
      await activateView();
      if (migrationSucceeded) await saveSettings();
    } catch (rollbackError) {
      console.error('[ClaudeThreads] Failed to restore conversation placement after transition error:', rollbackError);
    }
    throw error;
  }
}

export function formatCompanionEditedFilesNotice(lastPath: string, fileCount: number): string {
  return `Showing ${lastPath} in the companion (${fileCount} edited file${fileCount === 1 ? '' : 's'} found).`;
}

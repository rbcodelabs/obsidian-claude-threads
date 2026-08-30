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

export class ConversationViewPlacementState {
  private placement: ConversationPlacement = 'classic';

  apply(state: unknown): void {
    const placement = (state as PersistedChatState | null)?.conversationPlacement;
    if (placement === 'classic' || placement === 'conversation-first') this.placement = placement;
  }

  serialize(activeThreadId: string | null): PersistedChatState {
    return { activeThreadId, conversationPlacement: this.placement };
  }
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

export async function activateChatPlacement(
  plan: ConversationFirstChatPlan,
  createDestination: () => WorkspaceLeaf | null,
  viewType: string,
  placement: ConversationPlacement,
): Promise<WorkspaceLeaf> {
  if (plan.keep) {
    for (const duplicate of plan.detach) duplicate.detach();
    return plan.keep;
  }
  const destination = createDestination();
  if (!destination) {
    const location = placement === 'classic' ? 'sidebar' : 'main-area';
    throw new Error(`Unable to create a ${location} leaf for Claude Threads.`);
  }
  await destination.setViewState({
    type: viewType,
    active: true,
    state: {
      ...(plan.activeThreadId ? { activeThreadId: plan.activeThreadId } : {}),
      conversationPlacement: placement,
    },
  });
  for (const source of plan.detach) source.detach();
  return destination;
}

export function activateConversationFirstChat(
  plan: ConversationFirstChatPlan,
  createDestination: () => WorkspaceLeaf | null,
  viewType: string,
): Promise<WorkspaceLeaf> {
  return activateChatPlacement(plan, createDestination, viewType, 'conversation-first');
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
  if (settingsId && exists(settingsId)) return settingsId;
  if (viewStateId && exists(viewStateId)) return viewStateId;
  return fallbackId;
}

export function resolveHostRestoredActiveThread(
  activeAfterOnOpen: string | null,
  incomingHostStateId: string | null,
  settingsId: string | undefined,
  exists: (id: string) => boolean,
): string | null {
  if (settingsId && exists(settingsId)) return settingsId;
  if (activeAfterOnOpen && exists(activeAfterOnOpen)) return activeAfterOnOpen;
  if (incomingHostStateId && exists(incomingHostStateId)) return incomingHostStateId;
  return null;
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
  if (fileCount === 0) return 'No edited vault files are available.';
  return `Showing ${lastPath} in the companion (${fileCount} edited file${fileCount === 1 ? '' : 's'} found).`;
}

export function resolveFinalCompanionFile<T>(
  paths: string[],
  resolve: (path: string) => T | null,
  isFile: (candidate: T) => boolean = () => true,
): { path: string; file: T; validCount: number } | null {
  let final: { path: string; file: T } | null = null;
  let validCount = 0;
  for (const path of paths) {
    const file = resolve(path);
    if (!file || !isFile(file)) continue;
    final = { path, file };
    validCount++;
  }
  return final ? { ...final, validCount } : null;
}

export function sanitizeConversationCompanionSettings(settings: Record<string, unknown>): void {
  delete settings.conversationCompanion;
  const marker = settings.conversationCompanionMarker;
  if (typeof marker !== 'string' || !/^ct-companion-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker)) {
    delete settings.conversationCompanionMarker;
  }
}

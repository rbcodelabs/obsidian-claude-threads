import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { activateConversationFirstChat, formatCompanionEditedFilesNotice, isConversationFirstPlacement, persistActiveThreadSelection, planClassicChat, planConversationFirstChat, resolvePersistedActiveThread, transitionConversationPlacement } from '../../src/conversationFirstPlacement';
import { DEFAULT_SETTINGS } from '../../src/types';

function leaf(state: Record<string, unknown> = {}): WorkspaceLeaf {
  return { view: { getState: () => state } } as unknown as WorkspaceLeaf;
}

describe('conversation-first placement', () => {
  it('remains opt-in for existing installs', () => expect(DEFAULT_SETTINGS.threadViewPlacement).toBe('classic'));
  it('never enables conversation-first placement on mobile', () => {
    expect(isConversationFirstPlacement('conversation-first', true)).toBe(false);
    expect(isConversationFirstPlacement('conversation-first', false)).toBe(true);
  });
  it('keeps one explicitly marked main chat and removes duplicates', () => {
    const main = leaf({ activeThreadId: 'main-thread', conversationPlacement: 'conversation-first' });
    const duplicate = leaf({ activeThreadId: 'sidebar-thread', conversationPlacement: 'classic' });
    expect(planConversationFirstChat([duplicate, main])).toEqual({ keep: main, detach: [duplicate], activeThreadId: 'main-thread' });
  });
  it('carries selection when recreating sidebar chat in main', () => {
    const sidebar = leaf({ activeThreadId: 'selected-thread', conversationPlacement: 'classic' });
    expect(planConversationFirstChat([sidebar])).toEqual({ keep: null, detach: [sidebar], activeThreadId: 'selected-thread' });
  });
  it('is idempotent for one marked main chat', () => {
    const main = leaf({ conversationPlacement: 'conversation-first' });
    expect(planConversationFirstChat([main])).toEqual({ keep: main, detach: [], activeThreadId: undefined });
  });
  it('initializes destination with its marker before detaching source', async () => {
    const events: string[] = [];
    const source = leaf({ activeThreadId: 'selected-thread', conversationPlacement: 'classic' });
    source.detach = () => events.push('detach-source');
    const destination = { setViewState: async (state: unknown) => {
      events.push('initialize-destination');
      expect(state).toEqual({ type: 'claude-threads-view', active: true, state: { activeThreadId: 'selected-thread', conversationPlacement: 'conversation-first' } });
    } } as unknown as WorkspaceLeaf;
    await activateConversationFirstChat(planConversationFirstChat([source]), () => destination, 'claude-threads-view');
    expect(events).toEqual(['initialize-destination', 'detach-source']);
  });
  it('keeps source attached when destination initialization fails', async () => {
    let detached = false;
    const source = leaf({ activeThreadId: 'selected-thread', conversationPlacement: 'classic' });
    source.detach = () => { detached = true; };
    const destination = { setViewState: async () => { throw new Error('host refused'); } } as unknown as WorkspaceLeaf;
    await expect(activateConversationFirstChat(planConversationFirstChat([source]), () => destination, 'claude-threads-view')).rejects.toThrow('host refused');
    expect(detached).toBe(false);
  });
});

describe('classic placement restoration', () => {
  it('keeps one marked sidebar chat and removes duplicates', () => {
    const sidebar = leaf({ activeThreadId: 'sidebar-thread', conversationPlacement: 'classic' });
    const duplicate = leaf({ activeThreadId: 'main-thread', conversationPlacement: 'conversation-first' });
    expect(planClassicChat([duplicate, sidebar])).toEqual({ keep: sidebar, detach: [duplicate], activeThreadId: 'sidebar-thread' });
  });
  it('preserves selection when main chat must be recreated in sidebar', () => {
    const main = leaf({ activeThreadId: 'selected-thread', conversationPlacement: 'conversation-first' });
    expect(planClassicChat([main])).toEqual({ keep: null, detach: [main], activeThreadId: 'selected-thread' });
  });
  it('keeps a legacy unmarked singleton as classic placement', () => {
    const sidebar = leaf();
    expect(planClassicChat([sidebar]).keep).toBe(sidebar);
  });
});

describe('conversation placement persistence', () => {
  it('persists selection for restart and requests host layout persistence', async () => {
    const settings = { activeThreadId: undefined as string | undefined };
    const requestSaveLayout = vi.fn();
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    await persistActiveThreadSelection({ requestSaveLayout }, settings, saveSettings, 'thread-2');
    expect(settings.activeThreadId).toBe('thread-2');
    expect(requestSaveLayout).toHaveBeenCalledOnce();
    expect(saveSettings).toHaveBeenCalledOnce();
  });
  it('restores previous policy and layout when migration fails', async () => {
    const settings: { threadViewPlacement: 'classic' | 'conversation-first' } = { threadViewPlacement: 'classic' };
    const activateView = vi.fn().mockRejectedValueOnce(new Error('host refused')).mockResolvedValueOnce(undefined);
    const saveSettings = vi.fn();
    await expect(transitionConversationPlacement(settings, 'conversation-first', activateView, saveSettings)).rejects.toThrow('host refused');
    expect(settings.threadViewPlacement).toBe('classic');
    expect(activateView).toHaveBeenCalledTimes(2);
    expect(saveSettings).not.toHaveBeenCalled();
  });
  it('persists new policy only after migration succeeds', async () => {
    const events: string[] = [];
    const settings: { threadViewPlacement: 'classic' | 'conversation-first' } = { threadViewPlacement: 'classic' };
    await transitionConversationPlacement(settings, 'conversation-first', async () => { events.push('migrate'); }, async () => { events.push('persist'); });
    expect(events).toEqual(['migrate', 'persist']);
    expect(settings.threadViewPlacement).toBe('conversation-first');
  });

  it('restores persisted selection after a view is recreated', () => {
    const existing = new Set(['thread-1', 'thread-2']);
    expect(resolvePersistedActiveThread(null, 'thread-2', (id) => existing.has(id), 'thread-1')).toBe('thread-2');
  });

  it('re-persists the prior policy if persistence fails after a successful migration', async () => {
    const settings: { threadViewPlacement: 'classic' | 'conversation-first' } = { threadViewPlacement: 'classic' };
    const saveSettings = vi.fn().mockRejectedValueOnce(new Error('disk failed')).mockResolvedValueOnce(undefined);
    await expect(transitionConversationPlacement(settings, 'conversation-first', vi.fn().mockResolvedValue(undefined), saveSettings))
      .rejects.toThrow('disk failed');
    expect(settings.threadViewPlacement).toBe('classic');
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });
});

describe('companion edited-file feedback', () => {
  it('states that the final edited file is shown instead of claiming every file remains open', () => {
    expect(formatCompanionEditedFilesNotice('Notes/b.md', 2))
      .toBe('Showing Notes/b.md in the companion (2 edited files found).');
  });
});

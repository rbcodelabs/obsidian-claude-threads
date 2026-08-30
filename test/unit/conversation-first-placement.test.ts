import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { activateChatPlacement, activateConversationFirstChat, ConversationViewPlacementState, formatCompanionEditedFilesNotice, isConversationFirstPlacement, persistActiveThreadSelection, planClassicChat, planConversationFirstChat, resolveFinalCompanionFile, resolveHostRestoredActiveThread, resolvePersistedActiveThread, sanitizeConversationCompanionSettings, transitionConversationPlacement } from '../../src/conversationFirstPlacement';
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
  it('keeps instance placement stable when the global setting changes before planning', () => {
    const viewState = new ConversationViewPlacementState();
    viewState.apply({ conversationPlacement: 'classic' });
    const viewLike = { view: { getState: () => viewState.serialize('thread-1') } } as unknown as WorkspaceLeaf;
    const globalSettings = { threadViewPlacement: 'classic' as 'classic' | 'conversation-first' };

    globalSettings.threadViewPlacement = 'conversation-first';
    expect(planConversationFirstChat([viewLike]).keep).toBeNull();

    viewState.apply({ conversationPlacement: 'conversation-first' });
    globalSettings.threadViewPlacement = 'classic';
    expect(planClassicChat([viewLike]).keep).toBeNull();
  });
  it('moves the same live view Classic → conversation-first → Classic after global policy changes', async () => {
    const events: string[] = [];
    const placementState = new ConversationViewPlacementState();
    placementState.apply({ conversationPlacement: 'classic' });
    const classicLeaf = {
      view: { getState: () => placementState.serialize('thread-1') },
      detach: () => events.push('detach-classic'),
    } as unknown as WorkspaceLeaf;
    const mainLeaf = {
      view: { getState: () => placementState.serialize('thread-1') },
      setViewState: async (state: { state?: unknown }) => {
        placementState.apply(state.state);
        events.push('open-main');
      },
      detach: () => events.push('detach-main'),
    } as unknown as WorkspaceLeaf;
    const sidebarLeaf = {
      view: { getState: () => placementState.serialize('thread-1') },
      setViewState: async (state: { state?: unknown }) => {
        placementState.apply(state.state);
        events.push('open-sidebar');
      },
    } as unknown as WorkspaceLeaf;

    const movedMain = await activateChatPlacement(
      planConversationFirstChat([classicLeaf]), () => mainLeaf, 'chat', 'conversation-first',
    );
    expect(movedMain).toBe(mainLeaf);
    expect(planConversationFirstChat([mainLeaf]).keep).toBe(mainLeaf);

    const movedSidebar = await activateChatPlacement(
      planClassicChat([mainLeaf]), () => sidebarLeaf, 'chat', 'classic',
    );
    expect(movedSidebar).toBe(sidebarLeaf);
    expect(planClassicChat([sidebarLeaf]).keep).toBe(sidebarLeaf);
    expect(events).toEqual(['open-main', 'detach-classic', 'open-sidebar', 'detach-main']);
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
  it('prefers the newer settings selection over stale but valid host view state', () => {
    const existing = new Set(['thread-a', 'thread-b']);
    expect(resolvePersistedActiveThread('thread-a', 'thread-b', (id) => existing.has(id), 'thread-a'))
      .toBe('thread-b');
  });
  it('keeps settings-selected B when Geode runs onOpen(B) before setState(stale A)', () => {
    const existing = new Set(['thread-a', 'thread-b']);
    const afterOnOpen = 'thread-b';
    expect(resolveHostRestoredActiveThread(
      afterOnOpen,
      'thread-a',
      'thread-b',
      (id) => existing.has(id),
    )).toBe('thread-b');
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
  it('resolves first and opens only the final valid edited file', () => {
    const files = new Map([['Notes/a.md', { path: 'Notes/a.md' }], ['Notes/c.md', { path: 'Notes/c.md' }]]);
    expect(resolveFinalCompanionFile(['Notes/a.md', 'Notes/missing.md', 'Notes/c.md'], (path) => files.get(path) ?? null))
      .toEqual({ path: 'Notes/c.md', file: { path: 'Notes/c.md' }, validCount: 2 });
  });
  it('skips folders and returns only a real file candidate', () => {
    const folder = { path: 'Notes', children: [] };
    const file = { path: 'Notes/a.md' };
    const resolved = resolveFinalCompanionFile(
      ['Notes', 'Notes/a.md'],
      (path) => path === 'Notes' ? folder : file,
      (candidate) => !('children' in candidate),
    );
    expect(resolved).toEqual({ path: 'Notes/a.md', file, validCount: 1 });
  });
  it('emits correct feedback when no edited vault files still exist', () => {
    expect(formatCompanionEditedFilesNotice('', 0)).toBe('No edited vault files are available.');
  });
});

describe('companion persistence sanitization', () => {
  it('removes legacy arbitrary view state and rejects a non-plugin marker', () => {
    const settings: Record<string, unknown> = {
      conversationCompanion: { type: 'webviewer', state: { url: 'https://example.com?token=secret' } },
      conversationCompanionMarker: 'https://example.com?token=secret',
    };
    sanitizeConversationCompanionSettings(settings);
    expect(settings).not.toHaveProperty('conversationCompanion');
    expect(settings).not.toHaveProperty('conversationCompanionMarker');
    expect(JSON.stringify(settings)).not.toContain('secret');
  });
});

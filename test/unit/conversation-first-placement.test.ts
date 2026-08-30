import { describe, expect, it } from 'vitest';
import type { WorkspaceLeaf, WorkspaceRoot } from 'obsidian';
import { planConversationFirstChat } from '../../src/conversationFirstPlacement';
import { DEFAULT_SETTINGS } from '../../src/types';

function leaf(root: object, activeThreadId?: string): WorkspaceLeaf {
  return {
    getRoot: () => root,
    view: {
      getState: () => activeThreadId ? { activeThreadId } : {},
    },
  } as unknown as WorkspaceLeaf;
}

describe('conversation-first placement', () => {
  it('remains opt-in for existing installs', () => {
    expect(DEFAULT_SETTINGS.threadViewPlacement).toBe('classic');
  });

  it('keeps one existing main-area chat and removes only duplicate chat leaves', () => {
    const root = {} as WorkspaceRoot;
    const main = leaf(root, 'main-thread');
    const duplicate = leaf({}, 'sidebar-thread');

    expect(planConversationFirstChat([duplicate, main], root)).toEqual({
      keep: main,
      detach: [duplicate],
      activeThreadId: 'main-thread',
    });
  });

  it('carries the selected thread forward when recreating a sidebar chat in main', () => {
    const root = {} as WorkspaceRoot;
    const sidebar = leaf({}, 'selected-thread');

    expect(planConversationFirstChat([sidebar], root)).toEqual({
      keep: null,
      detach: [sidebar],
      activeThreadId: 'selected-thread',
    });
  });

  it('is idempotent when one main-area chat already exists', () => {
    const root = {} as WorkspaceRoot;
    const main = leaf(root);

    expect(planConversationFirstChat([main], root)).toEqual({
      keep: main,
      detach: [],
      activeThreadId: undefined,
    });
  });
});

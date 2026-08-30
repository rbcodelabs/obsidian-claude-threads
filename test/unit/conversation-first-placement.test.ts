import { describe, expect, it } from 'vitest';
import type { WorkspaceLeaf, WorkspaceRoot, WorkspaceSidedock } from 'obsidian';
import {
  isConversationFirstPlacement,
  planClassicChat,
  planConversationFirstChat,
} from '../../src/conversationFirstPlacement';
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

  it('never enables conversation-first placement on mobile even when the raw setting requests it', () => {
    expect(isConversationFirstPlacement('conversation-first', true)).toBe(false);
    expect(isConversationFirstPlacement('conversation-first', false)).toBe(true);
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

describe('classic placement restoration', () => {
  it('keeps one existing sidebar chat and removes only duplicate chat leaves', () => {
    const left = {} as WorkspaceSidedock;
    const right = {} as WorkspaceSidedock;
    const sidebar = leaf(left, 'sidebar-thread');
    const duplicate = leaf({}, 'main-thread');

    expect(planClassicChat([duplicate, sidebar], left, right)).toEqual({
      keep: sidebar,
      detach: [duplicate],
      activeThreadId: 'sidebar-thread',
    });
  });

  it('preserves activeThreadId when a main-area chat must be recreated in the sidebar', () => {
    const main = leaf({}, 'selected-thread');

    expect(planClassicChat([main], {} as WorkspaceSidedock, {} as WorkspaceSidedock)).toEqual({
      keep: null,
      detach: [main],
      activeThreadId: 'selected-thread',
    });
  });

  it('is idempotent for a singleton right-sidebar chat', () => {
    const right = {} as WorkspaceSidedock;
    const sidebar = leaf(right);

    expect(planClassicChat([sidebar], {} as WorkspaceSidedock, right)).toEqual({
      keep: sidebar,
      detach: [],
      activeThreadId: undefined,
    });
  });
});

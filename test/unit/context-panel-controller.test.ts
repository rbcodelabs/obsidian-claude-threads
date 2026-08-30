import { describe, expect, it, vi } from 'vitest';
import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import { ContextPanelController } from '../../src/ContextPanelController';

function makeLeaf(name: string) {
  return {
    name,
    view: {},
    getViewState: vi.fn().mockReturnValue({ type: 'markdown', state: {} }),
    openFile: vi.fn().mockResolvedValue(undefined),
    setViewState: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceLeaf & {
    name: string;
    openFile: ReturnType<typeof vi.fn>;
    setViewState: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(restoredIdentity?: { type: string; state: Record<string, unknown> }) {
  const chat = makeLeaf('chat');
  const firstCompanion = makeLeaf('companion-1');
  const secondCompanion = makeLeaf('companion-2');
  const attached = new Set<WorkspaceLeaf>([chat]);
  if (restoredIdentity) attached.add(firstCompanion);
  const splitActiveLeaf = vi
    .fn()
    .mockImplementationOnce(() => {
      attached.add(firstCompanion);
      return firstCompanion;
    })
    .mockImplementationOnce(() => {
      attached.add(secondCompanion);
      return secondCompanion;
    });
  const workspace = {
    iterateAllLeaves: vi.fn((callback: (leaf: WorkspaceLeaf) => void) => {
      for (const leaf of attached) callback(leaf);
    }),
    splitActiveLeaf,
    revealLeaf: vi.fn(),
    openLinkText: vi.fn().mockResolvedValue(undefined),
  };
  const app = { workspace } as unknown as App;
  firstCompanion.getViewState = vi.fn().mockReturnValue(restoredIdentity ?? { type: 'empty', state: {} });
  let identity = restoredIdentity;
  const createController = () => new ContextPanelController(
    app,
    () => chat,
    () => identity,
    async (next) => { identity = next; },
  );
  const controller = createController();
  return { controller, createController, workspace, chat, firstCompanion, secondCompanion, attached };
}

describe('ContextPanelController', () => {
  it('creates one right-adjacent companion and reuses it for later files', async () => {
    const { controller, workspace, chat, firstCompanion } = makeHarness();
    const firstFile = { path: 'Notes/first.md' } as TFile;
    const secondFile = { path: 'Notes/second.md' } as TFile;

    await controller.openFile(firstFile);
    await controller.openFile(secondFile);

    expect(workspace.revealLeaf).toHaveBeenNthCalledWith(1, chat);
    expect(workspace.splitActiveLeaf).toHaveBeenCalledTimes(1);
    expect(workspace.splitActiveLeaf).toHaveBeenCalledWith('vertical');
    expect(firstCompanion.openFile).toHaveBeenNthCalledWith(1, firstFile);
    expect(firstCompanion.openFile).toHaveBeenNthCalledWith(2, secondFile);
    expect(workspace.revealLeaf).toHaveBeenLastCalledWith(firstCompanion);
  });

  it('creates a fresh companion after the previous leaf is closed', async () => {
    const { controller, workspace, firstCompanion, secondCompanion, attached } = makeHarness();

    await controller.openFile({ path: 'Notes/first.md' } as TFile);
    attached.delete(firstCompanion);
    await controller.openFile({ path: 'Notes/second.md' } as TFile);

    expect(workspace.splitActiveLeaf).toHaveBeenCalledTimes(2);
    expect(secondCompanion.openFile).toHaveBeenCalledOnce();
  });

  it('opens internal links from the companion instead of replacing chat', async () => {
    const { controller, workspace, firstCompanion } = makeHarness();

    await controller.openLinkText('Daily/Today', 'Claude/thread.md');

    expect(workspace.revealLeaf).toHaveBeenLastCalledWith(firstCompanion);
    expect(workspace.openLinkText).toHaveBeenCalledWith('Daily/Today', 'Claude/thread.md', false);
  });

  it('can place a native registered view in the same reusable companion', async () => {
    const { controller, firstCompanion } = makeHarness();

    await controller.setViewState({ type: 'webviewer', active: true, state: { url: 'https://example.com' } });

    expect(firstCompanion.setViewState).toHaveBeenCalledWith({
      type: 'webviewer',
      active: true,
      state: { url: 'https://example.com' },
    });
  });

  it('rehydrates the restored companion after controller recreation without creating a duplicate', async () => {
    const identity = { type: 'markdown', state: { file: 'Notes/context.md' } };
    const { createController, workspace, firstCompanion } = makeHarness(identity);
    const reloadedController = createController();
    await reloadedController.openFile({ path: 'Notes/next.md' } as TFile);
    expect(workspace.splitActiveLeaf).not.toHaveBeenCalled();
    expect(firstCompanion.openFile).toHaveBeenCalledOnce();
  });
});

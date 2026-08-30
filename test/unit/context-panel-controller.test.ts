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

function makeHarness(restoredMarker?: string, unrelatedLeaves: WorkspaceLeaf[] = []) {
  const chat = makeLeaf('chat');
  const firstCompanion = makeLeaf('companion-1');
  const secondCompanion = makeLeaf('companion-2');
  const attached = new Set<WorkspaceLeaf>([chat, ...unrelatedLeaves]);
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
  let marker = restoredMarker;
  const createController = () => new ContextPanelController(
    app,
    () => chat,
    () => marker,
    async (next) => { marker = next; },
  );
  const controller = createController();
  return { controller, createController, workspace, chat, firstCompanion, secondCompanion, attached, getMarker: () => marker };
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

    const reused = await controller.setViewState({ type: 'webviewer', active: true, state: { url: 'https://example.com' } });

    expect(firstCompanion.setViewState).toHaveBeenCalledWith({
      type: 'webviewer',
      active: true,
      state: { url: 'https://example.com' },
    });
    expect(reused).toBe(false);
  });

  it('rehydrates only the controller-owned adjacent companion after controller recreation', async () => {
    const { controller, createController, workspace, firstCompanion } = makeHarness();
    await controller.openFile({ path: 'Notes/context.md' } as TFile);
    const reloadedController = createController();
    await reloadedController.openFile({ path: 'Notes/next.md' } as TFile);
    expect(workspace.splitActiveLeaf).toHaveBeenCalledOnce();
    expect(firstCompanion.openFile).toHaveBeenCalledTimes(2);
  });

  it('reports reuse when a restored companion handles a contextual view', async () => {
    const { controller, createController } = makeHarness();
    await controller.setViewState({ type: 'webviewer', state: { url: 'https://old.example?token=secret' } });
    const reused = await createController().setViewState({ type: 'webviewer', state: { url: 'https://new.example' } });
    expect(reused).toBe(true);
  });

  it('does not adopt either unrelated leaf when two native views have identical state', async () => {
    const unrelatedA = makeLeaf('unrelated-a');
    const unrelatedB = makeLeaf('unrelated-b');
    unrelatedA.getViewState = vi.fn().mockReturnValue({ type: 'webviewer', state: { url: 'https://same.example?token=secret' } });
    unrelatedB.getViewState = vi.fn().mockReturnValue({ type: 'webviewer', state: { url: 'https://same.example?token=secret' } });
    const { controller, workspace, firstCompanion } = makeHarness('stale-marker', [unrelatedA, unrelatedB]);
    await controller.setViewState({ type: 'webviewer', state: { url: 'https://same.example?token=secret' } });
    expect(workspace.splitActiveLeaf).toHaveBeenCalledOnce();
    expect(firstCompanion.setViewState).toHaveBeenCalledOnce();
    expect(unrelatedA.setViewState).not.toHaveBeenCalled();
    expect(unrelatedB.setViewState).not.toHaveBeenCalled();
  });

  it('replaces a stale marker after the owned companion is closed', async () => {
    const { controller, createController, firstCompanion, secondCompanion, attached, getMarker } = makeHarness();
    await controller.openFile({ path: 'Notes/first.md' } as TFile);
    const firstMarker = getMarker();
    attached.delete(firstCompanion);
    await createController().openFile({ path: 'Notes/second.md' } as TFile);
    expect(secondCompanion.openFile).toHaveBeenCalledOnce();
    expect(getMarker()).not.toBe(firstMarker);
  });

  it('persists only a sanitized opaque marker, never native view state', async () => {
    const { controller, getMarker } = makeHarness();
    await controller.setViewState({ type: 'webviewer', state: { url: 'https://example.com?token=secret' } });
    expect(getMarker()).toMatch(/^ct-companion-/);
    expect(JSON.stringify(getMarker())).not.toContain('secret');
  });
});

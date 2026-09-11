/**
 * @vitest-environment jsdom
 *
 * User-clicked links have different tab semantics from the agent-facing
 * host_open_url tool: every ordinary click preserves the page already open in
 * the Web Viewer. These tests exercise the real rendered-link listener and
 * ThreadsView.openLink boundary in both placements.
 */
import { describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';

vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => true }));

async function renderAndClick(view: ThreadsView, url: string): Promise<void> {
  const container = document.createElement('div');
  await (view as unknown as {
    renderMarkdown(markdown: string, el: HTMLElement): Promise<void>;
  }).renderMarkdown(`[Example](${url})`, container);
  container.querySelector<HTMLAnchorElement>('a')!.click();
}

function makeView(conversationFirst: boolean) {
  const existingSetViewState = vi.fn().mockResolvedValue(undefined);
  const newSetViewState = vi.fn().mockResolvedValue(undefined);
  const existingLeaf = { setViewState: existingSetViewState };
  const newLeaf = { setViewState: newSetViewState };
  const setViewStateInNewTab = vi.fn().mockResolvedValue(undefined);
  const view = Object.create(ThreadsView.prototype) as ThreadsView & Record<string, unknown>;
  view.app = {
    vault: { getAbstractFileByPath: vi.fn() },
    workspace: {
      getLeavesOfType: vi.fn(() => [existingLeaf]),
      getLeaf: vi.fn(() => newLeaf),
      revealLeaf: vi.fn(),
      openLinkText: vi.fn(),
    },
  } as never;
  view.plugin = {
    settings: { enableInlineVisualizations: false },
    isConversationFirst: () => conversationFirst,
    contextPanel: {
      setViewState: vi.fn().mockResolvedValue(true),
      setViewStateInNewTab,
    },
  } as never;
  view.manager = { getThread: vi.fn() } as never;
  view.activeThreadId = null;
  view.visualizeManager = undefined;
  return { view, existingSetViewState, newSetViewState, setViewStateInNewTab };
}

describe('rendered external link tab behavior', () => {
  it('opens a fresh Web Viewer tab in classic placement without replacing an existing page', async () => {
    const h = makeView(false);
    await renderAndClick(h.view, 'https://example.com/classic');

    expect(h.existingSetViewState).not.toHaveBeenCalled();
    expect(h.newSetViewState).toHaveBeenCalledWith({
      type: 'webviewer', active: true, state: { url: 'https://example.com/classic' },
    });
  });

  it('opens a fresh tab in the conversation-first context region without replacing its current page', async () => {
    const h = makeView(true);
    await renderAndClick(h.view, 'https://example.com/context');

    await vi.waitFor(() => expect(h.setViewStateInNewTab).toHaveBeenCalledWith({
      type: 'webviewer', active: true, state: { url: 'https://example.com/context' },
    }));
  });
});

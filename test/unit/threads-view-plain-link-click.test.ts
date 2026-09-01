/**
 * @vitest-environment jsdom
 *
 * Regression tests for "inline links in the conversation from Codex/Claude
 * don't work — clicking does nothing":
 *
 *  Root cause 1: a rendered markdown link whose href is an OS-absolute path
 *  that happens to fall under the vault root (e.g.
 *  `/Users/rick/Documents/Personal/Products/Geode/Runs/foo.md`) was passed
 *  straight through to ContextPanelController.openLinkText / the classic
 *  openLinkText call, both of which expect vault-relative linktext — so the
 *  lookup silently failed and nothing happened. Fixed by resolving such
 *  hrefs through resolveAbsoluteVaultHref() before opening.
 *
 *  Root cause 2: in classic placement (the default — threadViewPlacement
 *  defaults to 'classic' in src/types.ts), no click listener was ever
 *  attached to plain `[label](path)` links at all — the handler bailed out
 *  immediately via `if (!this.plugin.isConversationFirst() || ...) return`.
 *  Only conversation-first mode got a working handler. Fixed by attaching
 *  the listener unconditionally and branching on isConversationFirst()
 *  *inside* the handler, mirroring the existing a.internal-link handler.
 *
 * ThreadsView is a full Obsidian ItemView; this suite instantiates it via
 * Object.create(ThreadsView.prototype) (see threads-view-focus.test.ts for
 * the established pattern) so renderMarkdown() can be exercised directly
 * against real jsdom nodes without standing up the full view lifecycle.
 */

import { describe, it, expect } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';

interface Harness {
  view: ThreadsView;
  contextPanelCalls: Array<[string, string]>;
  workspaceCalls: string[];
}

function makeView(opts: { conversationFirst: boolean; vaultFiles?: string[]; noteFile?: string }): Harness {
  const contextPanelCalls: Array<[string, string]> = [];
  const workspaceCalls: string[] = [];
  const view = Object.create(ThreadsView.prototype) as ThreadsView & Record<string, unknown>;

  (view as unknown as { app: unknown }).app = {
    vault: {
      getAbstractFileByPath: (p: string) => ((opts.vaultFiles ?? []).includes(p) ? { path: p } : null),
    },
    workspace: {
      openLinkText: (href: string) => { workspaceCalls.push(href); },
    },
  };
  (view as unknown as { plugin: unknown }).plugin = {
    settings: { enableInlineVisualizations: false },
    isConversationFirst: () => opts.conversationFirst,
    contextPanel: {
      openLinkText: async (href: string, sourcePath: string) => { contextPanelCalls.push([href, sourcePath]); },
    },
  };
  (view as unknown as { manager: unknown }).manager = {
    getThread: () => (opts.noteFile ? { noteFile: opts.noteFile } : undefined),
  };
  (view as unknown as { activeThreadId: string | null }).activeThreadId = 'tid';
  (view as unknown as { visualizeManager: unknown }).visualizeManager = undefined;

  return { view, contextPanelCalls, workspaceCalls };
}

async function renderAndClick(harness: Harness, markdown: string): Promise<HTMLAnchorElement> {
  const el = document.createElement('div');
  const render = (harness.view as unknown as {
    renderMarkdown(markdown: string, el: HTMLElement): Promise<void>;
  }).renderMarkdown.bind(harness.view);
  await render(markdown, el);
  const link = el.querySelector('a') as HTMLAnchorElement;
  expect(link).not.toBeNull();
  link.click();
  return link;
}

describe('ThreadsView renderMarkdown — plain markdown link clicks (classic placement)', () => {
  it('attaches a click listener and routes through app.workspace.openLinkText', async () => {
    const harness = makeView({ conversationFirst: false });
    await renderAndClick(harness, '[Plan](Notes/Plan.md)');
    expect(harness.workspaceCalls).toEqual(['Notes/Plan.md']);
    expect(harness.contextPanelCalls).toEqual([]);
  });

  it('resolves an OS-absolute path under the vault root before opening', async () => {
    const abs = '/Users/rickbowman/Library/Mobile Documents/com~apple~CloudDocs/Documents/Personal/Products/Geode/Runs/geode-2026-09-01-architecture-review.md';
    const harness = makeView({
      conversationFirst: false,
      vaultFiles: ['Products/Geode/Runs/geode-2026-09-01-architecture-review.md'],
    });
    await renderAndClick(harness, `[Geode Architecture Review](<${abs}>)`);
    expect(harness.workspaceCalls).toEqual(['Products/Geode/Runs/geode-2026-09-01-architecture-review.md']);
  });

  it('falls back to the raw href when no vault suffix resolves', async () => {
    const abs = '/Users/rickbowman/elsewhere/note.md';
    const harness = makeView({ conversationFirst: false, vaultFiles: [] });
    await renderAndClick(harness, `[Note](<${abs}>)`);
    expect(harness.workspaceCalls).toEqual([abs]);
  });

  it('decodes percent-encoded spaces (marked encodes them) before suffix-matching a path whose vault-relative portion has a space', async () => {
    // marked emits `href="...Products/Geode/Runs/My%20Report.md"` for a
    // markdown link target containing a literal space. The vault-relative
    // suffix here itself contains the space, so matching only works if the
    // href is decoded before being probed against getAbstractFileByPath.
    const abs = '/Users/rickbowman/Vault/Products/Geode/Runs/My Report.md';
    const harness = makeView({
      conversationFirst: false,
      vaultFiles: ['Products/Geode/Runs/My Report.md'],
    });
    await renderAndClick(harness, `[My Report](<${abs}>)`);
    expect(harness.workspaceCalls).toEqual(['Products/Geode/Runs/My Report.md']);
  });
});

describe('ThreadsView renderMarkdown — plain markdown link clicks (conversation-first placement)', () => {
  it('attaches a click listener and routes through contextPanel.openLinkText with the thread note as sourcePath', async () => {
    const harness = makeView({ conversationFirst: true, noteFile: 'Threads/my-thread.md' });
    await renderAndClick(harness, '[Plan](Notes/Plan.md)');
    expect(harness.contextPanelCalls).toEqual([['Notes/Plan.md', 'Threads/my-thread.md']]);
    expect(harness.workspaceCalls).toEqual([]);
  });

  it('resolves an OS-absolute path under the vault root before opening', async () => {
    const abs = '/Users/rickbowman/Library/Mobile Documents/com~apple~CloudDocs/Documents/Personal/Products/Geode/Runs/geode-2026-09-01-architecture-review.md';
    const harness = makeView({
      conversationFirst: true,
      vaultFiles: ['Products/Geode/Runs/geode-2026-09-01-architecture-review.md'],
    });
    await renderAndClick(harness, `[Geode Architecture Review](<${abs}>)`);
    expect(harness.contextPanelCalls).toEqual([
      ['Products/Geode/Runs/geode-2026-09-01-architecture-review.md', ''],
    ]);
  });
});

describe('ThreadsView renderMarkdown — external and same-page links stay inert', () => {
  it('does not attach a click listener to an external link', async () => {
    const harness = makeView({ conversationFirst: false });
    const el = document.createElement('div');
    const render = (harness.view as unknown as {
      renderMarkdown(markdown: string, el: HTMLElement): Promise<void>;
    }).renderMarkdown.bind(harness.view);
    await render('[Example](https://example.com)', el);
    const link = el.querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.click();
    expect(harness.workspaceCalls).toEqual([]);
    expect(harness.contextPanelCalls).toEqual([]);
  });
});

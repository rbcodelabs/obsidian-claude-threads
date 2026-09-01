import { describe, it, expect, vi } from 'vitest';
import { classifyRenderedMarkdownLink, openUrlPreferringWebViewer, resolveAbsoluteVaultHref } from '../../src/linkUtils';
import type { App } from 'obsidian';

function fakeApp(opts: { existingWebviewer?: boolean } = {}) {
  const setViewState = vi.fn(() => Promise.resolve());
  const reveal = vi.fn();
  const existingLeaf = { setViewState };
  const newLeaf = { setViewState };
  const ws = {
    getLeavesOfType: vi.fn((t: string) => (opts.existingWebviewer && t === 'webviewer' ? [existingLeaf] : [])),
    getLeaf: vi.fn(() => newLeaf),
    revealLeaf: reveal,
  };
  return { app: { workspace: ws } as unknown as App, setViewState, reveal, ws, existingLeaf, newLeaf };
}

describe('openUrlPreferringWebViewer', () => {
  it('opens externally when the Web Viewer is disabled', () => {
    const { app, setViewState } = fakeApp();
    const openExternal = vi.fn();
    const path = openUrlPreferringWebViewer(app, 'https://x/pull/1', { webViewerEnabled: false, openExternal });
    expect(path).toBe('external');
    expect(openExternal).toHaveBeenCalledWith('https://x/pull/1');
    expect(setViewState).not.toHaveBeenCalled();
  });

  it('forces the system browser (Cmd/Ctrl-click) even with a Web Viewer tab open', () => {
    // Cmd-click maps to webViewerEnabled:false; it must NOT reuse an open viewer tab.
    const { app, setViewState, ws } = fakeApp({ existingWebviewer: true });
    const openExternal = vi.fn();
    const path = openUrlPreferringWebViewer(app, 'https://x/pull/9', { webViewerEnabled: false, openExternal });
    expect(path).toBe('external');
    expect(openExternal).toHaveBeenCalledWith('https://x/pull/9');
    expect(setViewState).not.toHaveBeenCalled();
    expect(ws.getLeavesOfType).not.toHaveBeenCalled();
  });

  it('opens in the Web Viewer when enabled (new tab) and does not open externally', () => {
    const { app, setViewState, reveal, ws } = fakeApp({ existingWebviewer: false });
    const openExternal = vi.fn();
    const path = openUrlPreferringWebViewer(app, 'https://x/pull/2', { webViewerEnabled: true, openExternal });
    expect(path).toBe('webviewer');
    expect(ws.getLeaf).toHaveBeenCalledWith('tab');
    expect(reveal).toHaveBeenCalled();
    expect(setViewState).toHaveBeenCalledWith({ type: 'webviewer', active: true, state: { url: 'https://x/pull/2' } });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reuses an existing webviewer tab when one is open', () => {
    const { app, ws } = fakeApp({ existingWebviewer: true });
    const openExternal = vi.fn();
    openUrlPreferringWebViewer(app, 'https://x', { webViewerEnabled: true, openExternal });
    expect(ws.getLeavesOfType).toHaveBeenCalledWith('webviewer');
    expect(ws.getLeaf).not.toHaveBeenCalled(); // reused, no new tab
  });

  it('uses a caller-selected contextual leaf instead of an unrelated webviewer tab', () => {
    const { app, ws, existingLeaf } = fakeApp({ existingWebviewer: true });
    const contextualLeaf = { setViewState: vi.fn().mockResolvedValue(undefined) };
    const openExternal = vi.fn();

    openUrlPreferringWebViewer(app, 'https://x/context', {
      webViewerEnabled: true,
      openExternal,
      destinationLeaf: contextualLeaf as never,
    });

    expect(ws.getLeavesOfType).not.toHaveBeenCalled();
    expect(existingLeaf.setViewState).not.toHaveBeenCalled();
    expect(contextualLeaf.setViewState).toHaveBeenCalledWith({
      type: 'webviewer',
      active: true,
      state: { url: 'https://x/context' },
    });
  });

  it('falls back to external when the workspace throws', () => {
    const ws = {
      getLeavesOfType: () => { throw new Error('no webviewer'); },
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(),
    };
    const app = { workspace: ws } as unknown as App;
    const openExternal = vi.fn();
    const path = openUrlPreferringWebViewer(app, 'https://x', { webViewerEnabled: true, openExternal });
    expect(path).toBe('external');
    expect(openExternal).toHaveBeenCalledWith('https://x');
  });
});

describe('classifyRenderedMarkdownLink', () => {
  it.each(['Notes/Plan.md', '../Plans/Roadmap%20Q4.md#Decision', 'Daily/Today#^block'])('classifies %s as a vault link', (href) => {
    expect(classifyRenderedMarkdownLink(href)).toBe('vault');
  });

  it.each(['https://example.com', 'mailto:team@example.com', 'obsidian://open?vault=x', 'tel:+15551212', '#same-page', 'file:///tmp/a.md'])('keeps %s outside vault routing', (href) => {
    expect(classifyRenderedMarkdownLink(href)).toBe('external');
  });
});

describe('resolveAbsoluteVaultHref', () => {
  it('resolves an OS-absolute unix path to the shortest existing vault-relative suffix', () => {
    const exists = (p: string) => ['Products/Geode/Runs/geode-2026-09-01-architecture-review.md', 'geode-2026-09-01-architecture-review.md'].includes(p);
    const href = '/Users/rickbowman/Library/Mobile Documents/com~apple~CloudDocs/Documents/Personal/Products/Geode/Runs/geode-2026-09-01-architecture-review.md';
    expect(resolveAbsoluteVaultHref(href, exists)).toBe('Products/Geode/Runs/geode-2026-09-01-architecture-review.md');
  });

  it('returns null when no suffix of an absolute path resolves', () => {
    const exists = () => false;
    expect(resolveAbsoluteVaultHref('/Users/rick/Documents/Personal/nope.md', exists)).toBeNull();
  });

  it('returns null for an already vault-relative href, even if exists would match', () => {
    const exists = () => true;
    expect(resolveAbsoluteVaultHref('Notes/Plan.md', exists)).toBeNull();
  });

  it('resolves a Windows-style absolute path', () => {
    const exists = (p: string) => p === 'Docs/note.md';
    expect(resolveAbsoluteVaultHref('C:\\Users\\rick\\Vault\\Docs\\note.md', exists)).toBe('Docs/note.md');
  });

  it('returns the longest matching suffix, not just any match', () => {
    const exists = (p: string) => ['Docs/note.md', 'note.md'].includes(p);
    expect(resolveAbsoluteVaultHref('/Users/rick/Vault/Docs/note.md', exists)).toBe('Docs/note.md');
  });

  // marked percent-encodes hrefs, so a vault path containing a space arrives
  // as "Claude%20Threads" while the vault index holds the literal space.
  it('resolves a percent-encoded space inside the vault-relative portion', () => {
    const exists = (p: string) => p === 'Products/Claude Threads/notes.md';
    const href = '/Users/rick/Library/Mobile%20Documents/Personal/Products/Claude%20Threads/notes.md';
    expect(resolveAbsoluteVaultHref(href, exists)).toBe('Products/Claude Threads/notes.md');
  });

  it('prefers a raw match over the decoded one when a filename really contains %20', () => {
    const exists = (p: string) => p === 'Docs/odd%20name.md';
    expect(resolveAbsoluteVaultHref('/Users/rick/Vault/Docs/odd%20name.md', exists)).toBe('Docs/odd%20name.md');
  });

  it('survives a malformed percent-escape without throwing', () => {
    const exists = (p: string) => p === 'Docs/100%.md';
    expect(resolveAbsoluteVaultHref('/Users/rick/Vault/Docs/100%.md', exists)).toBe('Docs/100%.md');
  });
});

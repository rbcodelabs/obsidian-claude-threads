import { describe, it, expect, vi } from 'vitest';
import { openUrlPreferringWebViewer } from '../../src/linkUtils';
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
  return { app: { workspace: ws } as unknown as App, setViewState, reveal, ws };
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

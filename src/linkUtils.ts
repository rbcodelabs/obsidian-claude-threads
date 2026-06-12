/**
 * Shared link-opening behavior: prefer Obsidian's in-app Web Viewer when the
 * core plugin is enabled, otherwise fall back to the system browser. Isolated
 * here (with injected deps) so the branch logic is unit-testable without a real
 * Obsidian workspace or electron.
 */
import type { App } from 'obsidian';

export interface OpenUrlDeps {
  /** Whether the Web Viewer core plugin is enabled. */
  webViewerEnabled: boolean;
  /** Open the URL in the system browser (electron shell.openExternal). */
  openExternal: (url: string) => void;
}

/**
 * Open `url`, preferring the Web Viewer when enabled. Reuses an existing
 * webviewer tab if one is open. Falls back to the system browser when the Web
 * Viewer is disabled or fails to load. Returns the path taken (for tests).
 */
export function openUrlPreferringWebViewer(app: App, url: string, deps: OpenUrlDeps): 'webviewer' | 'external' {
  if (!deps.webViewerEnabled) {
    deps.openExternal(url);
    return 'external';
  }
  try {
    const ws = app.workspace;
    const existing = ws.getLeavesOfType('webviewer');
    const leaf = existing.length > 0 ? existing[0] : ws.getLeaf('tab');
    ws.revealLeaf(leaf);
    void Promise.resolve(leaf.setViewState({ type: 'webviewer', active: true, state: { url } }))
      .catch(() => deps.openExternal(url));
    return 'webviewer';
  } catch {
    deps.openExternal(url);
    return 'external';
  }
}

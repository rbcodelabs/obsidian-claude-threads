/**
 * Shared link-opening behavior: prefer Obsidian's in-app Web Viewer when the
 * core plugin is enabled, otherwise fall back to the system browser. Isolated
 * here (with injected deps) so the branch logic is unit-testable without a real
 * Obsidian workspace or electron.
 */
import type { App, WorkspaceLeaf } from 'obsidian';

/** Whether a rendered Markdown href represents vault navigation. */
export function classifyRenderedMarkdownLink(href: string): 'vault' | 'external' {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return 'external';
  // Any URI scheme (http:, mailto:, obsidian:, file:, data:, etc.) remains
  // under the host/browser's ordinary external-link behavior.
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return 'external';
  return 'vault';
}

/**
 * If `href` looks like an OS-absolute path (unix "/..." or Windows "C:\..."),
 * resolve it to a vault-relative path by probing successively shorter path
 * suffixes against `exists` (typically `app.vault.getAbstractFileByPath`).
 * Returns null if href isn't absolute-looking, or no suffix resolves.
 *
 * marked percent-encodes hrefs, so a path containing a space arrives as
 * `.../Claude%20Threads/notes.md` while the vault index holds the literal
 * `Claude Threads/notes.md`. Each suffix is therefore probed both raw and
 * percent-decoded — raw first, so a file whose real name legitimately
 * contains a "%20" still wins over the decoded interpretation.
 */
export function resolveAbsoluteVaultHref(href: string, exists: (path: string) => boolean): string | null {
  const trimmed = href.trim();
  if (!/^(\/|[a-zA-Z]:[\\/])/.test(trimmed)) return null;
  const segments = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join('/');
    if (exists(candidate)) return candidate;
    let decoded: string | null = null;
    try { decoded = decodeURIComponent(candidate); } catch { /* malformed escape — raw probe stands */ }
    if (decoded !== null && decoded !== candidate && exists(decoded)) return decoded;
  }
  return null;
}

export interface OpenUrlDeps {
  /** Whether the Web Viewer core plugin is enabled. */
  webViewerEnabled: boolean;
  /** Open the URL in the system browser (electron shell.openExternal). */
  openExternal: (url: string) => void;
  /** Explicit native leaf selected by conversation-first contextual routing. */
  destinationLeaf?: WorkspaceLeaf;
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
    const existing = deps.destinationLeaf ? [] : ws.getLeavesOfType('webviewer');
    const leaf = deps.destinationLeaf ?? (existing.length > 0 ? existing[0] : ws.getLeaf('tab'));
    ws.revealLeaf(leaf);
    void Promise.resolve(leaf.setViewState({ type: 'webviewer', active: true, state: { url } }))
      .catch(() => deps.openExternal(url));
    return 'webviewer';
  } catch {
    deps.openExternal(url);
    return 'external';
  }
}

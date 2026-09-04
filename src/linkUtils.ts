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
 * Whether `href` looks like an OS-absolute filesystem path (unix "/..." or
 * Windows "C:\..."). Call sites use this to tell "this was a filesystem path
 * we failed to map into the vault" apart from "this was an ordinary relative
 * link" — the former must not be forwarded to the host's link-opening APIs,
 * which would treat it as an unresolved vault link.
 *
 * Note that `classifyRenderedMarkdownLink` already routes Windows drive
 * letters to 'external' (the drive letter parses as a URI scheme), so in
 * practice only the unix branch is reachable from the rendered-markdown call
 * sites. The Windows branch is kept for direct callers and future use.
 */
export function isOsAbsoluteHref(href: string): boolean {
  return /^(\/|[a-zA-Z]:[\\/])/.test(href.trim());
}

/**
 * If `href` looks like an OS-absolute path (unix "/..." or Windows "C:\..."),
 * resolve it to a vault-relative path by probing successively shorter path
 * suffixes against `exists` (typically `app.vault.getAbstractFileByPath`).
 * Returns null if href isn't absolute-looking, or no suffix resolves.
 *
 * marked percent-encodes hrefs, so a path containing a space arrives as
 * `.../Claude%20Threads/notes.md` while the vault index holds the literal
 * `Agent Threads/notes.md`. Each suffix is therefore probed both raw and
 * percent-decoded — raw first, so a file whose real name legitimately
 * contains a "%20" still wins over the decoded interpretation. (That
 * precedence holds for what this function returns; a caller that decodes
 * again downstream can still collapse the two.)
 *
 * A trailing `#heading` / `#^block` subpath is split off before probing —
 * otherwise it would be glued onto the final path segment and no candidate
 * would ever match the vault index — then reattached to the resolved path so
 * the open call can still scroll to the target. The subpath is decoded on
 * reattach: marked encodes `#^block` as `#%5Eblock` and `#My Heading` as
 * `#My%20Heading`, and nothing downstream decodes the subpath (Obsidian's
 * parseLinktext splits it off, and ContextPanelController decodes only the
 * path half), so an encoded subpath would never match its target.
 */
export function resolveAbsoluteVaultHref(href: string, exists: (path: string) => boolean): string | null {
  const trimmed = href.trim();
  if (!isOsAbsoluteHref(trimmed)) return null;
  const hash = trimmed.indexOf('#');
  const pathPart = hash === -1 ? trimmed : trimmed.slice(0, hash);
  let subpath = hash === -1 ? '' : trimmed.slice(hash);
  if (subpath) {
    try { subpath = decodeURIComponent(subpath); } catch { /* malformed escape — keep raw */ }
  }
  const segments = pathPart.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join('/');
    if (exists(candidate)) return candidate + subpath;
    let decoded: string | null = null;
    try { decoded = decodeURIComponent(candidate); } catch { /* malformed escape — raw probe stands */ }
    if (decoded !== null && decoded !== candidate && exists(decoded)) return decoded + subpath;
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

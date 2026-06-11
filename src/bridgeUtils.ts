/**
 * Helpers for interoperating with the vault-bridges plugin.
 *
 * A Vault Bridge mirrors a folder of a local git repo into the vault. When an
 * agent edits files in the *repo* copy (rather than the synced vault copy), we
 * want to (a) detect that, (b) trigger a bridge pull so the vault copy
 * refreshes, and (c) map repo-absolute paths to vault-relative paths so links
 * open the vault note inside Obsidian.
 *
 * Mobile-safe: pure string logic, no Node.js built-ins.
 */
import type { App } from 'obsidian';

export interface BridgeInfo {
  id: string;
  name: string;
  /** Absolute local path to the git repo root. */
  repoPath: string;
  /** Subfolder within the repo that is mirrored ('' = whole repo). */
  sourcePath: string;
  /** Vault-relative destination folder. */
  vaultPath: string;
  branch: string;
  autoSync: boolean;
  status: string;
  /** When set, the bridge's git ops target this worktree instead of repoPath. */
  activeWorktreePath?: string;
  lastSynced?: string;
  isDirty?: boolean;
  lastError?: string;
}

export interface VaultBridgesPluginAPI {
  getBridges(): BridgeInfo[];
  syncBridge(id: string): Promise<void>;
}

/** Returns the vault-bridges plugin API, or null if not installed/enabled. */
export function getVaultBridgesAPI(app: App): VaultBridgesPluginAPI | null {
  const vb = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
    .plugins?.plugins?.['vault-bridges'] as { api?: VaultBridgesPluginAPI } | undefined;
  return vb?.api ?? null;
}

/** Normalize separators and strip trailing slashes so prefix matching is reliable. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Absolute roots whose contents this bridge mirrors into the vault. */
export function bridgeRoots(bridge: BridgeInfo): string[] {
  const roots: string[] = [];
  const source = norm(bridge.sourcePath ?? '');
  for (const base of [bridge.repoPath, bridge.activeWorktreePath]) {
    if (!base) continue;
    roots.push(source ? `${norm(base)}/${source}` : norm(base));
  }
  return roots;
}

export interface BridgeMatch {
  bridge: BridgeInfo;
  /** Vault-relative path of the synced copy of the file. */
  vaultRelPath: string;
}

/**
 * Maps an absolute file path to the vault-relative path of its synced copy,
 * if the path falls inside any bridge's mirrored source tree. Returns null
 * for paths outside every bridge (including vault-internal paths).
 */
export function mapToVaultPath(absPath: string, bridges: BridgeInfo[]): BridgeMatch | null {
  const p = norm(absPath);
  for (const bridge of bridges) {
    if (!bridge.vaultPath) continue;
    for (const root of bridgeRoots(bridge)) {
      if (p === root || p.startsWith(root + '/')) {
        const rel = p === root ? '' : p.slice(root.length + 1);
        const vaultRelPath = rel ? `${norm(bridge.vaultPath)}/${rel}` : norm(bridge.vaultPath);
        return { bridge, vaultRelPath };
      }
    }
  }
  return null;
}

/** Returns the unique bridges whose mirrored source tree contains any of the given absolute paths. */
export function findBridgesForFiles(paths: Iterable<string>, bridges: BridgeInfo[]): BridgeInfo[] {
  const matched = new Map<string, BridgeInfo>();
  for (const p of paths) {
    const m = mapToVaultPath(p, bridges);
    if (m && !matched.has(m.bridge.id)) matched.set(m.bridge.id, m.bridge);
  }
  return [...matched.values()];
}

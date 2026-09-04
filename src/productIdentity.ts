/** Public product identity and intentionally stable upgrade contracts. */
export const PRODUCT_NAME = 'Agent Threads';
export const DEFAULT_VAULT_FOLDER = 'Agent Threads';
export const DIAGNOSTICS_FOLDER = 'agent-threads-diagnostics';
export const WELCOME_GUIDE_NAME = 'Getting Started with Agent Threads.md';
export const LEGACY_WELCOME_GUIDE_NAME = 'Getting Started with Claude Threads.md';

// These identifiers must remain stable so upgrades keep views, hotkeys and tools.
export const LEGACY_MCP_SERVER_NAME = 'claude_threads';

export function welcomeGuidePaths(vaultFolder: string): { current: string; legacy: string } {
  return {
    current: `${vaultFolder}/${WELCOME_GUIDE_NAME}`,
    legacy: `${vaultFolder}/${LEGACY_WELCOME_GUIDE_NAME}`,
  };
}

/** Merge persisted settings without rewriting any nested legacy paths. */
export function mergePersistedSettings<T extends object>(defaults: T, saved: Partial<T> | null | undefined): T {
  return Object.assign({}, defaults, saved ?? {});
}

/** Select an existing guide first, preferring the current name when both exist. */
export function selectWelcomeGuidePath(
  vaultFolder: string,
  exists: (path: string) => boolean,
): { path: string; shouldCreate: boolean } {
  const paths = welcomeGuidePaths(vaultFolder);
  if (exists(paths.current)) return { path: paths.current, shouldCreate: false };
  if (exists(paths.legacy)) return { path: paths.legacy, shouldCreate: false };
  return { path: paths.current, shouldCreate: true };
}

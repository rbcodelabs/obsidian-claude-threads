/**
 * Converts an environment variable name to a valid Obsidian secret storage key.
 *
 * Obsidian's secretStorage.setSecret / getSecret require the key to contain only
 * lowercase letters, numbers, and dashes, with a max length of 64 characters.
 *
 * We prefix with 'ct-secret-' and normalize the env var name so that, e.g.,
 * 'LINEAR_API_KEY' maps to 'ct-secret-linear-api-key'.
 */
export function secretStorageKey(varName: string): string {
  const normalized = varName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // replace runs of non-alphanumeric chars (incl. underscores) with dashes
    .replace(/^-+|-+$/g, '');    // trim leading/trailing dashes
  return `ct-secret-${normalized}`.slice(0, 64);
}

/**
 * Decides whether a secret env var should be resolved for a given project.
 *
 * Semantics (see `PluginSettings.secretEnvScopes`):
 * - No `scopes` map, no entry for `varName`, or an empty list = global — the
 *   secret is visible everywhere, matching pre-scoping behavior exactly.
 * - A non-empty list restricts visibility to those project ids only.
 * - A caller with no project at all (`projectId === undefined`) never sees a
 *   scoped secret, even though it still sees every global one. This is a
 *   deliberate, stricter default for project-less threads/scheduled items.
 */
export function isSecretVisibleToProject(
  scopes: Record<string, string[]> | undefined,
  varName: string,
  projectId: string | undefined,
): boolean {
  const scopeList = scopes?.[varName];
  if (!scopeList || scopeList.length === 0) return true;
  return projectId !== undefined && scopeList.includes(projectId);
}

/**
 * Removes a deleted project's id from every list in `secretEnvScopes`,
 * dropping the varName key entirely once its list becomes empty (so a
 * project-scoped-to-nothing secret reverts to global rather than becoming
 * unreachable). Called from `deleteProject` to keep the map tidy.
 */
export function pruneSecretEnvScopesForProject(
  scopes: Record<string, string[]> | undefined,
  projectId: string,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [varName, ids] of Object.entries(scopes ?? {})) {
    const filtered = ids.filter((id) => id !== projectId);
    if (filtered.length > 0) result[varName] = filtered;
  }
  return result;
}

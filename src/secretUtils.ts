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

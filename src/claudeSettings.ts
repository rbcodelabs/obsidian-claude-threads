/**
 * Utilities for reading GitHub skill source manifests and deriving
 * the skills directory for a cloned repo.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as typeof import('path');

/**
 * Read the plugin name from .claude-plugin/plugin.json in the given repo directory.
 * Returns null if the manifest is missing or malformed.
 */
export function readPluginManifest(repoPath: string): { name: string; displayName?: string; skills?: string } | null {
  try {
    const manifestPath = path.join(repoPath, '.claude-plugin', 'plugin.json');
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.name !== 'string') return null;
    return {
      name: parsed.name as string,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined,
      skills: typeof parsed.skills === 'string' ? parsed.skills : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Derive the skills directory path from a github source's clonePath.
 * Reads plugin.json if available; falls back to "<clonePath>/skills".
 */
export function getSkillsDirForSource(clonePath: string): string {
  const manifest = readPluginManifest(clonePath);
  if (manifest?.skills) {
    // skills field in plugin.json can be a relative path
    return path.join(clonePath, manifest.skills);
  }
  return path.join(clonePath, 'skills');
}

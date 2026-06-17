/**
 * Utilities for reading and writing ~/.claude/settings.json to register
 * skill sources as Claude Code plugin marketplaces.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('os') as typeof import('os');

export interface ClaudeSettingsEntry {
  /** Marketplace ID (same as SkillSource.id) */
  marketplaceId: string;
  /** Absolute path to the cloned repo */
  clonePath: string;
  /** Plugin name from .claude-plugin/plugin.json (used in enabledPlugins key) */
  pluginName: string;
}

/** Path to Claude Code's global settings file */
function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Read and parse the settings file. Returns {} if missing or invalid. */
function readSettings(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Write settings back to disk, preserving all existing keys. */
function writeSettings(settings: Record<string, unknown>): void {
  const filePath = settingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Register a plugin source in ~/.claude/settings.json.
 * Adds to extraKnownMarketplaces and enabledPlugins.
 * Idempotent — safe to call multiple times with the same entry.
 */
export function registerPluginSource(entry: ClaudeSettingsEntry): void {
  const settings = readSettings();

  // extraKnownMarketplaces
  if (typeof settings.extraKnownMarketplaces !== 'object' || settings.extraKnownMarketplaces === null) {
    settings.extraKnownMarketplaces = {};
  }
  const marketplaces = settings.extraKnownMarketplaces as Record<string, unknown>;
  marketplaces[entry.marketplaceId] = {
    source: {
      source: 'directory',
      path: entry.clonePath,
    },
  };

  // enabledPlugins
  if (typeof settings.enabledPlugins !== 'object' || settings.enabledPlugins === null) {
    settings.enabledPlugins = {};
  }
  const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
  enabledPlugins[`${entry.pluginName}@${entry.marketplaceId}`] = true;

  writeSettings(settings);
}

/**
 * Remove a plugin source from ~/.claude/settings.json.
 * Removes from extraKnownMarketplaces and any matching enabledPlugins keys.
 */
export function unregisterPluginSource(marketplaceId: string, pluginName?: string): void {
  const settings = readSettings();

  // extraKnownMarketplaces
  if (typeof settings.extraKnownMarketplaces === 'object' && settings.extraKnownMarketplaces !== null) {
    const marketplaces = settings.extraKnownMarketplaces as Record<string, unknown>;
    delete marketplaces[marketplaceId];
  }

  // enabledPlugins — remove any key matching "@<marketplaceId>"
  if (typeof settings.enabledPlugins === 'object' && settings.enabledPlugins !== null) {
    const enabledPlugins = settings.enabledPlugins as Record<string, unknown>;
    if (pluginName) {
      delete enabledPlugins[`${pluginName}@${marketplaceId}`];
    } else {
      // Fallback: remove all keys ending with @<marketplaceId>
      for (const key of Object.keys(enabledPlugins)) {
        if (key.endsWith(`@${marketplaceId}`)) {
          delete enabledPlugins[key];
        }
      }
    }
  }

  writeSettings(settings);
}

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

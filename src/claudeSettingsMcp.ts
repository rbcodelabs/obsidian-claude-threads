/**
 * Reads the `mcpServers` section from ~/.claude/settings.json and returns it as
 * a map of server name → SDK McpServerConfig, suitable for merging into the
 * mcpServerFactory return value.
 *
 * Environment-variable placeholders of the form `${VAR_NAME}` inside string
 * values (e.g. Authorization headers, command paths) are resolved against the
 * provided `env` map merged with `process.env`.  Unknown or unresolvable
 * variables are replaced with an empty string so the config is still usable.
 *
 * SDK-type servers (type: "sdk") are excluded because they require a live
 * McpServer instance that cannot be serialized or reconstructed here.
 *
 * This function never throws — any error (missing file, bad JSON, unexpected
 * shape) is caught, logged as a warning, and an empty record is returned so
 * the caller can always safely spread the result.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('os') as typeof import('os');

/** Expand all ${VAR} occurrences in `value` using the supplied env map. */
function expandEnvVars(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => env[varName] ?? '');
}

/**
 * Recursively walk a plain-object value and resolve ${VAR} placeholders in
 * every string leaf.  Non-string primitives and arrays pass through unchanged.
 */
function resolveEnv(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === 'string') return expandEnvVars(value, env);
  if (Array.isArray(value)) return value.map((item) => resolveEnv(item, env));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveEnv(v, env);
    }
    return out;
  }
  return value;
}

/**
 * Read the mcpServers block from `~/.claude/settings.json` (symlinks are
 * resolved).  Env-var placeholders are expanded using `extraEnv` merged on
 * top of `process.env`.  Returns a plain Record suitable for spreading into
 * the session's mcpServers option.  Always returns an object — never throws.
 */
export function readClaudeSettingsMcp(
  extraEnv: Record<string, string> = {},
): Record<string, McpServerConfig> {
  try {
    // Follow the symlink so we always read the live file.
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let realPath: string;
    try {
      realPath = fs.realpathSync(settingsPath);
    } catch {
      // File doesn't exist or is otherwise inaccessible — nothing to merge.
      return {};
    }

    const raw = fs.readFileSync(realPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return {};
    }

    // Build the merged env once — callers supply resolved secrets on top of process.env.
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...extraEnv,
    };

    const result: Record<string, McpServerConfig> = {};

    for (const [name, rawConfig] of Object.entries(servers as Record<string, unknown>)) {
      if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) continue;

      const config = resolveEnv(rawConfig, mergedEnv) as Record<string, unknown>;
      const type = config.type as string | undefined;

      // Exclude sdk-type entries — they require a live McpServer instance.
      if (type === 'sdk') continue;

      // Accept http, sse, stdio (and the implicit-stdio case where type is absent).
      if (type === 'http' || type === 'sse' || type === 'stdio' || type === undefined) {
        result[name] = config as unknown as McpServerConfig;
      }
    }

    return result;
  } catch (err) {
    console.warn('[ClaudeThreads] Could not read mcpServers from ~/.claude/settings.json:', err);
    return {};
  }
}

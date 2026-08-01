/**
 * Raw CRUD operations for the `mcpServers` block of the global
 * `~/.claude/settings.json` file, used by the plugin's MCP settings UI.
 *
 * Unlike `claudeSettingsMcp.ts` (which resolves `${VAR}` placeholders for use
 * inside a live thread session), everything here operates on the UNRESOLVED
 * config exactly as it's stored on disk. Placeholders like `${API_KEY}` are
 * preserved verbatim — this module must never resolve or decrypt a secret,
 * because its output is shown directly in the settings UI.
 */

import { readRawClaudeSettings, resolveClaudeSettingsPath } from './claudeSettingsMcp';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as typeof import('path');

export interface RawMcpServer {
  name: string;
  type: 'stdio' | 'http' | 'sse' | 'sdk' | 'unknown';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Server names must be safe to use as a JSON object key / shell-ish identifier. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function stringRecord(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Convert one raw `mcpServers` entry (as stored in settings.json) into a RawMcpServer. */
function toRawMcpServer(name: string, config: unknown): RawMcpServer {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { name, type: 'unknown' };
  }
  const c = config as Record<string, unknown>;
  const rawType = typeof c.type === 'string' ? c.type : undefined;

  if (rawType === 'sdk') {
    return { name, type: 'sdk' };
  }

  if (rawType === 'http' || rawType === 'sse') {
    const server: RawMcpServer = { name, type: rawType };
    if (typeof c.url === 'string') server.url = c.url;
    if (c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers)) {
      server.headers = stringRecord(c.headers as Record<string, unknown>);
    }
    return server;
  }

  if (rawType === 'stdio' || rawType === undefined) {
    const server: RawMcpServer = { name, type: 'stdio' };
    if (typeof c.command === 'string') server.command = c.command;
    if (Array.isArray(c.args)) {
      server.args = c.args.filter((a): a is string => typeof a === 'string');
    }
    if (c.env && typeof c.env === 'object' && !Array.isArray(c.env)) {
      server.env = stringRecord(c.env as Record<string, unknown>);
    }
    return server;
  }

  // Explicit but unrecognized type (e.g. "grpc") — surface read-only rather than drop it.
  return { name, type: 'unknown' };
}

/** Build the on-disk config object for a given RawMcpServer, per its type. */
function buildConfig(server: RawMcpServer): Record<string, unknown> {
  if (server.type === 'stdio') {
    const config: Record<string, unknown> = { type: 'stdio', command: (server.command ?? '').trim() };
    if (server.args && server.args.length > 0) config.args = server.args;
    if (server.env && Object.keys(server.env).length > 0) config.env = server.env;
    return config;
  }
  // http | sse
  const config: Record<string, unknown> = { type: server.type, url: (server.url ?? '').trim() };
  if (server.headers && Object.keys(server.headers).length > 0) config.headers = server.headers;
  return config;
}

/** Read every mcpServers entry from the global settings file, unresolved. */
export function listMcpServers(): { servers: RawMcpServer[]; path: string; parseError?: string } {
  const { data, path: settingsPath, parseError } = readRawClaudeSettings();

  const serversObj = data.mcpServers;
  if (!serversObj || typeof serversObj !== 'object' || Array.isArray(serversObj)) {
    return { servers: [], path: settingsPath, parseError };
  }

  const servers = Object.entries(serversObj as Record<string, unknown>).map(([name, cfg]) =>
    toRawMcpServer(name, cfg),
  );

  return { servers, path: settingsPath, parseError };
}

function writeSettings(settingsPath: string, data: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Could not write settings.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Add or update one mcpServers entry. Re-reads the raw file at write time so
 * concurrent edits (e.g. someone editing settings.json by hand) aren't
 * clobbered by a stale in-memory copy. Pass `previousName` when renaming an
 * existing entry — the old key is removed and the new key inserted.
 */
export function saveMcpServer(
  server: RawMcpServer,
  previousName?: string,
): { ok: true } | { ok: false; error: string } {
  const name = server.name.trim();
  if (!name) {
    return { ok: false, error: 'Name is required.' };
  }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: 'Name may only contain letters, numbers, hyphens, and underscores.' };
  }
  if ((server.type === 'http' || server.type === 'sse') && !(server.url ?? '').trim()) {
    return { ok: false, error: 'URL is required.' };
  }
  if (server.type === 'stdio' && !(server.command ?? '').trim()) {
    return { ok: false, error: 'Command is required.' };
  }
  if (server.type !== 'stdio' && server.type !== 'http' && server.type !== 'sse') {
    return { ok: false, error: `Unsupported server type: ${server.type}` };
  }

  const { data, path: settingsPath, parseError } = readRawClaudeSettings();
  if (parseError) {
    return { ok: false, error: `Refusing to save — settings.json could not be parsed: ${parseError}` };
  }

  const existingServers: Record<string, unknown> =
    data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
      ? (data.mcpServers as Record<string, unknown>)
      : {};

  const collidesWithDifferentEntry =
    Object.prototype.hasOwnProperty.call(existingServers, name) && name !== previousName;
  if (collidesWithDifferentEntry) {
    return { ok: false, error: `An MCP server named "${name}" already exists.` };
  }

  const newServers: Record<string, unknown> = { ...existingServers };
  if (previousName && previousName !== name) {
    delete newServers[previousName];
  }
  newServers[name] = buildConfig(server);

  const newData: Record<string, unknown> = { ...data, mcpServers: newServers };
  return writeSettings(settingsPath, newData);
}

/**
 * Remove one mcpServers entry by name. No-op-safe: if the entry is already
 * absent (or the file doesn't exist), returns ok:true without writing.
 */
export function deleteMcpServer(name: string): { ok: true } | { ok: false; error: string } {
  const { data, path: settingsPath, parseError } = readRawClaudeSettings();
  if (parseError) {
    // We can't know whether the key exists without parsing the file, so
    // refuse rather than risk silently reporting success on a no-op.
    return { ok: false, error: `Refusing to modify — settings.json could not be parsed: ${parseError}` };
  }

  const existingServers: Record<string, unknown> =
    data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
      ? (data.mcpServers as Record<string, unknown>)
      : {};

  if (!Object.prototype.hasOwnProperty.call(existingServers, name)) {
    return { ok: true };
  }

  const newServers: Record<string, unknown> = { ...existingServers };
  delete newServers[name];

  const newData: Record<string, unknown> = { ...data, mcpServers: newServers };
  return writeSettings(settingsPath, newData);
}

// Re-export so callers of this module (the settings UI) can show the
// resolved global settings path without importing claudeSettingsMcp directly.
export { resolveClaudeSettingsPath };

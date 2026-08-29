/**
 * The plugin's own store of external MCP servers, backed by
 * `PluginSettings.mcpServers` in data.json.
 *
 * This module replaces the former `claudeSettingsMcp.ts` /
 * `claudeSettingsMcpEditor.ts` pair, which read and wrote a `mcpServers` block
 * inside `~/.claude/settings.json`. That was a squat: the file belongs to
 * Claude Code, its schema has no top-level `mcpServers` property, and no CLI or
 * SDK ever read what we put there. Nothing here touches that file.
 *
 * Two halves, deliberately kept apart:
 *
 * - The CRUD half (`listMcpServers` / `saveMcpServer` / `deleteMcpServer`)
 *   operates on the UNRESOLVED config exactly as stored. `${API_KEY}` stays
 *   verbatim, because this is what the settings UI renders.
 * - The resolve half (`resolveMcpServers`) expands `${VAR}` placeholders for a
 *   live session, and REFUSES to emit a server whose placeholders don't
 *   resolve. See the note on that function.
 *
 * Everything here is pure: no fs, no process spawning. Callers own persistence
 * (`saveSettings()`) and reporting.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { PluginSettings, StoredMcpServer } from './types';

/** Server names must be safe to use as a JSON object key / shell-ish identifier. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g;

/** One entry flattened for the settings UI (name folded in alongside its config). */
export interface McpServerEntry {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

function stringRecord(obj: unknown): Record<string, string> | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate one raw value from data.json into a StoredMcpServer, or null if it
 * isn't one. data.json is user-editable, so this never trusts its input.
 */
export function normalizeStoredServer(value: unknown): StoredMcpServer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  const type = c.type;

  if (type === 'http' || type === 'sse') {
    if (typeof c.url !== 'string' || c.url.trim() === '') return null;
    const server: StoredMcpServer = { type, url: c.url };
    const headers = stringRecord(c.headers);
    if (headers) server.headers = headers;
    return server;
  }

  if (type === 'stdio') {
    if (typeof c.command !== 'string' || c.command.trim() === '') return null;
    const server: StoredMcpServer = { type: 'stdio', command: c.command };
    if (Array.isArray(c.args)) {
      const args = c.args.filter((a): a is string => typeof a === 'string');
      if (args.length > 0) server.args = args;
    }
    const env = stringRecord(c.env);
    if (env) server.env = env;
    return server;
  }

  return null;
}

/**
 * Every stored entry, flattened for the UI and sorted by name. Entries that
 * fail validation are reported by name in `invalid` rather than silently
 * dropped, so hand-edited data.json damage is visible instead of vanishing.
 */
export function listMcpServers(
  settings: Pick<PluginSettings, 'mcpServers'>,
): { servers: McpServerEntry[]; invalid: string[] } {
  const stored = settings.mcpServers;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { servers: [], invalid: [] };
  }

  const servers: McpServerEntry[] = [];
  const invalid: string[] = [];

  for (const [name, raw] of Object.entries(stored)) {
    const normalized = normalizeStoredServer(raw);
    if (!normalized) {
      invalid.push(name);
      continue;
    }
    servers.push({ name, ...normalized });
  }

  servers.sort((a, b) => a.name.localeCompare(b.name));
  invalid.sort((a, b) => a.localeCompare(b));
  return { servers, invalid };
}

/** Strip the UI's flat `name` back off into the stored config shape. */
function toStoredServer(entry: McpServerEntry): StoredMcpServer {
  if (entry.type === 'stdio') {
    const server: StoredMcpServer = { type: 'stdio', command: (entry.command ?? '').trim() };
    if (entry.args && entry.args.length > 0) server.args = entry.args;
    if (entry.env && Object.keys(entry.env).length > 0) server.env = entry.env;
    return server;
  }
  const server: StoredMcpServer = { type: entry.type, url: (entry.url ?? '').trim() };
  if (entry.headers && Object.keys(entry.headers).length > 0) server.headers = entry.headers;
  return server;
}

/**
 * Add or update one entry, mutating `settings.mcpServers` in place. The caller
 * is responsible for persisting (`saveSettings()`). Pass `previousName` when
 * renaming — the old key is removed and the new one inserted.
 */
export function saveMcpServer(
  settings: Pick<PluginSettings, 'mcpServers'>,
  entry: McpServerEntry,
  previousName?: string,
): SaveResult {
  const name = entry.name.trim();
  if (!name) {
    return { ok: false, error: 'Name is required.' };
  }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: 'Name may only contain letters, numbers, hyphens, and underscores.' };
  }
  if (entry.type !== 'stdio' && entry.type !== 'http' && entry.type !== 'sse') {
    return { ok: false, error: `Unsupported server type: ${String(entry.type)}` };
  }
  if ((entry.type === 'http' || entry.type === 'sse') && !(entry.url ?? '').trim()) {
    return { ok: false, error: 'URL is required.' };
  }
  if (entry.type === 'stdio' && !(entry.command ?? '').trim()) {
    return { ok: false, error: 'Command is required.' };
  }

  if (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)) {
    settings.mcpServers = {};
  }

  const collidesWithDifferentEntry =
    Object.prototype.hasOwnProperty.call(settings.mcpServers, name) && name !== previousName;
  if (collidesWithDifferentEntry) {
    return { ok: false, error: `An MCP server named "${name}" already exists.` };
  }

  if (previousName && previousName !== name) {
    delete settings.mcpServers[previousName];
  }
  settings.mcpServers[name] = toStoredServer({ ...entry, name });
  return { ok: true };
}

/**
 * Remove one entry by name, mutating in place. No-op-safe: removing something
 * that isn't there succeeds without changing anything.
 */
export function deleteMcpServer(
  settings: Pick<PluginSettings, 'mcpServers'>,
  name: string,
): SaveResult {
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)) {
    return { ok: true };
  }
  delete settings.mcpServers[name];
  return { ok: true };
}

/** Collect every `${VAR}` name appearing in any string leaf of `value`. */
function collectPlaceholders(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
      into.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectPlaceholders(v, into);
  }
}

/**
 * Names of `${VAR}` placeholders in `server` that `env` cannot fill.
 *
 * An empty-string value counts as unresolved on purpose: an `x-api-key` header
 * expanded to `""` is not a working server, it's a silent 401.
 */
export function findUnresolvedPlaceholders(
  server: StoredMcpServer | McpServerEntry,
  env: Record<string, string>,
): string[] {
  const found = new Set<string>();
  collectPlaceholders(server, found);
  return [...found].filter((name) => !env[name]).sort((a, b) => a.localeCompare(b));
}

/** Expand every `${VAR}` in every string leaf. Only called once all resolve. */
function expand(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_PATTERN, (_, varName: string) => env[varName] ?? '');
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, env));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expand(v, env);
    }
    return out;
  }
  return value;
}

export interface ResolvedMcpServers {
  /** Ready to spread into a session's mcpServers option. */
  servers: Record<string, McpServerConfig>;
  /** One human-readable line per server that was refused. */
  warnings: string[];
}

/**
 * Resolve the stored servers for a live session.
 *
 * A server whose `${VAR}` placeholders cannot all be filled is EXCLUDED and
 * reported — never injected with the gaps blanked out. The previous
 * implementation expanded an unknown variable to `''` and injected anyway,
 * which shipped an empty `x-api-key` header on every session for months with
 * no error anywhere: the server appeared to be configured, connected, and then
 * silently failed auth. A missing server the user is told about is strictly
 * better than a present one that cannot work.
 *
 * Never throws — a caller can always spread `.servers`.
 */
export function resolveMcpServers(
  stored: Record<string, StoredMcpServer> | undefined,
  env: Record<string, string>,
): ResolvedMcpServers {
  const servers: Record<string, McpServerConfig> = {};
  const warnings: string[] = [];

  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { servers, warnings };
  }

  for (const [name, raw] of Object.entries(stored)) {
    const normalized = normalizeStoredServer(raw);
    if (!normalized) {
      warnings.push(`MCP server "${name}" is not a valid entry and was skipped.`);
      continue;
    }

    const missing = findUnresolvedPlaceholders(normalized, env);
    if (missing.length > 0) {
      warnings.push(
        `MCP server "${name}" was not loaded: ${missing.map((m) => `\${${m}}`).join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} unset. ` +
        `Add ${missing.length === 1 ? 'it' : 'them'} under Settings → Secrets.`,
      );
      continue;
    }

    servers[name] = expand(normalized, env) as unknown as McpServerConfig;
  }

  return { servers, warnings };
}

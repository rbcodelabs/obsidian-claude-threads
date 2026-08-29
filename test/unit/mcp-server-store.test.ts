import { describe, expect, it } from 'vitest';
import {
  deleteMcpServer,
  findUnresolvedPlaceholders,
  listMcpServers,
  normalizeStoredServer,
  resolveMcpServers,
  saveMcpServer,
  type McpServerEntry,
} from '../../src/mcpServerStore';
import type { PluginSettings, StoredMcpServer } from '../../src/types';

function settingsWith(mcpServers: Record<string, unknown>): Pick<PluginSettings, 'mcpServers'> {
  return { mcpServers: mcpServers as Record<string, StoredMcpServer> };
}

describe('normalizeStoredServer', () => {
  it('accepts a well-formed stdio entry and drops empty optional fields', () => {
    expect(normalizeStoredServer({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'] })).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
    });
    // args: [] and env: {} are noise — they should not survive normalization.
    expect(normalizeStoredServer({ type: 'stdio', command: 'npx', args: [], env: {} })).toEqual({
      type: 'stdio',
      command: 'npx',
    });
  });

  it('accepts http and sse entries with headers', () => {
    expect(
      normalizeStoredServer({ type: 'http', url: 'https://x.test/mcp', headers: { 'x-api-key': 'k' } }),
    ).toEqual({ type: 'http', url: 'https://x.test/mcp', headers: { 'x-api-key': 'k' } });
    expect(normalizeStoredServer({ type: 'sse', url: 'https://x.test/sse' })).toEqual({
      type: 'sse',
      url: 'https://x.test/sse',
    });
  });

  it('rejects entries that could never start', () => {
    expect(normalizeStoredServer(null)).toBeNull();
    expect(normalizeStoredServer('nope')).toBeNull();
    expect(normalizeStoredServer([])).toBeNull();
    expect(normalizeStoredServer({ type: 'stdio' })).toBeNull();
    expect(normalizeStoredServer({ type: 'stdio', command: '   ' })).toBeNull();
    expect(normalizeStoredServer({ type: 'http' })).toBeNull();
    expect(normalizeStoredServer({ type: 'http', url: '' })).toBeNull();
    // No sdk variant: it needs a live in-process instance that cannot be stored.
    expect(normalizeStoredServer({ type: 'sdk', name: 'x' })).toBeNull();
  });
});

describe('listMcpServers', () => {
  it('returns entries sorted by name with the name folded in', () => {
    const settings = settingsWith({
      zeta: { type: 'stdio', command: 'z' },
      alpha: { type: 'http', url: 'https://a.test' },
    });
    const { servers, invalid } = listMcpServers(settings);
    expect(servers.map((s) => s.name)).toEqual(['alpha', 'zeta']);
    expect(invalid).toEqual([]);
  });

  it('reports invalid entries by name instead of silently dropping them', () => {
    const settings = settingsWith({
      good: { type: 'stdio', command: 'ok' },
      broken: { type: 'stdio' },
    });
    const { servers, invalid } = listMcpServers(settings);
    expect(servers.map((s) => s.name)).toEqual(['good']);
    expect(invalid).toEqual(['broken']);
  });

  it('tolerates a missing or malformed mcpServers block', () => {
    expect(listMcpServers({ mcpServers: undefined as never })).toEqual({ servers: [], invalid: [] });
    expect(listMcpServers({ mcpServers: [] as never })).toEqual({ servers: [], invalid: [] });
  });
});

describe('saveMcpServer', () => {
  it('adds a new entry into the settings object', () => {
    const settings = settingsWith({});
    const entry: McpServerEntry = { name: 'compass', type: 'http', url: 'https://c.test/mcp' };
    expect(saveMcpServer(settings, entry)).toEqual({ ok: true });
    expect(settings.mcpServers).toEqual({ compass: { type: 'http', url: 'https://c.test/mcp' } });
  });

  it('renames by removing the previous key', () => {
    const settings = settingsWith({ old: { type: 'stdio', command: 'x' } });
    const result = saveMcpServer(settings, { name: 'new', type: 'stdio', command: 'x' }, 'old');
    expect(result).toEqual({ ok: true });
    expect(Object.keys(settings.mcpServers)).toEqual(['new']);
  });

  it('refuses a rename that would collide with a different entry', () => {
    const settings = settingsWith({
      a: { type: 'stdio', command: 'x' },
      b: { type: 'stdio', command: 'y' },
    });
    const result = saveMcpServer(settings, { name: 'b', type: 'stdio', command: 'x' }, 'a');
    expect(result).toEqual({ ok: false, error: 'An MCP server named "b" already exists.' });
    // The store must be untouched after a rejected save.
    expect(Object.keys(settings.mcpServers).sort()).toEqual(['a', 'b']);
  });

  it('allows saving an entry over itself (edit without rename)', () => {
    const settings = settingsWith({ a: { type: 'stdio', command: 'x' } });
    const result = saveMcpServer(settings, { name: 'a', type: 'stdio', command: 'y' }, 'a');
    expect(result).toEqual({ ok: true });
    expect(settings.mcpServers.a).toEqual({ type: 'stdio', command: 'y' });
  });

  it('validates required fields per transport', () => {
    const settings = settingsWith({});
    expect(saveMcpServer(settings, { name: '', type: 'stdio', command: 'x' }).ok).toBe(false);
    expect(saveMcpServer(settings, { name: 'bad name', type: 'stdio', command: 'x' }).ok).toBe(false);
    expect(saveMcpServer(settings, { name: 'a', type: 'stdio', command: '  ' }).ok).toBe(false);
    expect(saveMcpServer(settings, { name: 'a', type: 'http', url: '' }).ok).toBe(false);
    expect(settings.mcpServers).toEqual({});
  });

  it('creates the mcpServers map when the settings object predates the feature', () => {
    const settings = { mcpServers: undefined as never } as Pick<PluginSettings, 'mcpServers'>;
    expect(saveMcpServer(settings, { name: 'a', type: 'stdio', command: 'x' })).toEqual({ ok: true });
    expect(settings.mcpServers).toEqual({ a: { type: 'stdio', command: 'x' } });
  });
});

describe('deleteMcpServer', () => {
  it('removes an entry and is a safe no-op for one that is absent', () => {
    const settings = settingsWith({ a: { type: 'stdio', command: 'x' } });
    expect(deleteMcpServer(settings, 'a')).toEqual({ ok: true });
    expect(settings.mcpServers).toEqual({});
    expect(deleteMcpServer(settings, 'ghost')).toEqual({ ok: true });
  });
});

describe('findUnresolvedPlaceholders', () => {
  it('finds placeholders across nested string leaves', () => {
    const server: StoredMcpServer = {
      type: 'http',
      url: 'https://${HOST}/mcp',
      headers: { 'x-api-key': '${KEY}', 'x-trace': 'static' },
    };
    expect(findUnresolvedPlaceholders(server, {})).toEqual(['HOST', 'KEY']);
    expect(findUnresolvedPlaceholders(server, { HOST: 'h', KEY: 'k' })).toEqual([]);
  });

  it('treats an empty-string value as unresolved', () => {
    // This is the whole point: an x-api-key expanded to "" is a silent 401,
    // not a configured server.
    const server: StoredMcpServer = { type: 'http', url: 'https://x.test', headers: { k: '${KEY}' } };
    expect(findUnresolvedPlaceholders(server, { KEY: '' })).toEqual(['KEY']);
  });
});

describe('resolveMcpServers', () => {
  it('expands placeholders in a fully resolvable server', () => {
    const { servers, warnings } = resolveMcpServers(
      { compass: { type: 'http', url: 'https://c.test/mcp', headers: { 'x-api-key': '${COMPASS_KEY}' } } },
      { COMPASS_KEY: 'secret-value' },
    );
    expect(warnings).toEqual([]);
    expect(servers).toEqual({
      compass: { type: 'http', url: 'https://c.test/mcp', headers: { 'x-api-key': 'secret-value' } },
    });
  });

  it('EXCLUDES a server whose placeholder is unset, instead of blanking it', () => {
    // Regression: the previous implementation expanded ${HIPTRIP_MCP_KEY} to ''
    // and injected the server anyway, shipping an empty x-api-key header on
    // every session with no error reported anywhere.
    const { servers, warnings } = resolveMcpServers(
      { hiptrip: { type: 'http', url: 'https://h.test/mcp', headers: { 'x-api-key': '${HIPTRIP_MCP_KEY}' } } },
      {},
    );
    expect(servers).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('hiptrip');
    expect(warnings[0]).toContain('${HIPTRIP_MCP_KEY}');
  });

  it('drops only the broken server and keeps the healthy ones', () => {
    const { servers, warnings } = resolveMcpServers(
      {
        good: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
        broken: { type: 'http', url: 'https://b.test', headers: { k: '${MISSING}' } },
      },
      {},
    );
    expect(Object.keys(servers)).toEqual(['good']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('broken');
  });

  it('warns about entries that are not valid servers at all', () => {
    const { servers, warnings } = resolveMcpServers({ junk: { type: 'stdio' } as never }, {});
    expect(servers).toEqual({});
    expect(warnings[0]).toContain('junk');
  });

  it('expands placeholders inside stdio env and args', () => {
    const { servers, warnings } = resolveMcpServers(
      { s: { type: 'stdio', command: 'run', args: ['--token=${TOK}'], env: { TOKEN: '${TOK}' } } },
      { TOK: 'abc' },
    );
    expect(warnings).toEqual([]);
    expect(servers.s).toEqual({
      type: 'stdio',
      command: 'run',
      args: ['--token=abc'],
      env: { TOKEN: 'abc' },
    });
  });

  it('returns empty for a missing or malformed store without throwing', () => {
    expect(resolveMcpServers(undefined, {})).toEqual({ servers: {}, warnings: [] });
    expect(resolveMcpServers([] as never, {})).toEqual({ servers: {}, warnings: [] });
  });
});

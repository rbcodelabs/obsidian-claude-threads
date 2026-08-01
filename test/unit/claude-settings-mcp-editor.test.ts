import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listMcpServers, saveMcpServer, deleteMcpServer } from '../../src/claudeSettingsMcpEditor';

/**
 * Tests for the raw MCP-server CRUD editor.
 *
 * Strategy: same as test/unit/claude-settings-mcp.test.ts — write a real
 * settings.json to a temp dir and override HOME so
 * path.join(os.homedir(), '.claude', 'settings.json') resolves into it.
 */

let tmpDir: string;
let origHome: string | undefined;

function claudeDir(): string {
  return path.join(tmpDir, '.claude');
}

function settingsFile(): string {
  return path.join(claudeDir(), 'settings.json');
}

function writeSettings(content: unknown): void {
  fs.mkdirSync(claudeDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(content, null, 2), 'utf-8');
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-mcp-editor-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  if (origHome !== undefined) {
    process.env.HOME = origHome;
  } else {
    delete process.env.HOME;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// listMcpServers
// ---------------------------------------------------------------------------

describe('listMcpServers', () => {
  it('returns an empty list when settings.json does not exist', () => {
    const result = listMcpServers();
    expect(result.servers).toEqual([]);
    expect(result.parseError).toBeUndefined();
    expect(result.path).toContain('.claude');
  });

  it('returns an empty list when mcpServers is absent', () => {
    writeSettings({ model: 'sonnet' });
    const result = listMcpServers();
    expect(result.servers).toEqual([]);
  });

  it('lists a populated stdio entry', () => {
    writeSettings({
      mcpServers: {
        mylocal: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'my-mcp'],
          env: { API_TOKEN: '${MY_TOKEN}' },
        },
      },
    });
    const result = listMcpServers();
    expect(result.servers).toEqual([
      {
        name: 'mylocal',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'my-mcp'],
        env: { API_TOKEN: '${MY_TOKEN}' },
      },
    ]);
  });

  it('lists an implicit-stdio entry (no type field) as stdio', () => {
    writeSettings({
      mcpServers: {
        nostdio: { command: 'node', args: ['server.js'] },
      },
    });
    const result = listMcpServers();
    expect(result.servers[0]).toMatchObject({ name: 'nostdio', type: 'stdio', command: 'node' });
  });

  it('lists a populated http entry', () => {
    writeSettings({
      mcpServers: {
        compass: {
          type: 'http',
          url: 'https://compass.example.com/api/mcp',
          headers: { Authorization: 'Bearer ${COMPASS_API_KEY}' },
        },
      },
    });
    const result = listMcpServers();
    expect(result.servers).toEqual([
      {
        name: 'compass',
        type: 'http',
        url: 'https://compass.example.com/api/mcp',
        headers: { Authorization: 'Bearer ${COMPASS_API_KEY}' },
      },
    ]);
  });

  it('lists a populated sse entry', () => {
    writeSettings({
      mcpServers: {
        mysse: { type: 'sse', url: 'https://sse.example.com/events' },
      },
    });
    const result = listMcpServers();
    expect(result.servers).toEqual([{ name: 'mysse', type: 'sse', url: 'https://sse.example.com/events' }]);
  });

  it('passes sdk entries through as type "sdk" without exposing their config', () => {
    writeSettings({
      mcpServers: {
        internal: { type: 'sdk', name: 'internal-tools' },
      },
    });
    const result = listMcpServers();
    expect(result.servers).toEqual([{ name: 'internal', type: 'sdk' }]);
  });

  it('surfaces unrecognized explicit types as "unknown" rather than dropping them', () => {
    writeSettings({
      mcpServers: {
        weird: { type: 'grpc', url: 'grpc://example.com' },
      },
    });
    const result = listMcpServers();
    expect(result.servers).toEqual([{ name: 'weird', type: 'unknown' }]);
  });

  it('surfaces a parseError for malformed JSON and does not throw', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ bad json {{', 'utf-8');
    const result = listMcpServers();
    expect(result.servers).toEqual([]);
    expect(result.parseError).toBeTruthy();
  });

  it('lists multiple entries of mixed types', () => {
    writeSettings({
      mcpServers: {
        a: { type: 'stdio', command: 'npx' },
        b: { type: 'http', url: 'https://example.com' },
        c: { type: 'sdk', name: 'sdk-thing' },
      },
    });
    const result = listMcpServers();
    expect(result.servers.map((s) => s.name).sort()).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// saveMcpServer
// ---------------------------------------------------------------------------

describe('saveMcpServer', () => {
  it('adds a new stdio server to a file with no prior mcpServers', () => {
    writeSettings({ model: 'sonnet' });
    const result = saveMcpServer({
      name: 'newstdio',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'my-mcp'],
      env: { API_TOKEN: 'x' },
    });
    expect(result).toEqual({ ok: true });

    const onDisk = readSettings();
    expect(onDisk.model).toBe('sonnet');
    expect(onDisk.mcpServers).toEqual({
      newstdio: { type: 'stdio', command: 'npx', args: ['-y', 'my-mcp'], env: { API_TOKEN: 'x' } },
    });
  });

  it('adds a new http/sse server', () => {
    writeSettings({ mcpServers: {} });
    const result = saveMcpServer({
      name: 'compass',
      type: 'http',
      url: 'https://compass.example.com/api/mcp',
      headers: { Authorization: 'Bearer ${COMPASS_API_KEY}' },
    });
    expect(result).toEqual({ ok: true });

    const onDisk = readSettings();
    expect(onDisk.mcpServers).toEqual({
      compass: {
        type: 'http',
        url: 'https://compass.example.com/api/mcp',
        headers: { Authorization: 'Bearer ${COMPASS_API_KEY}' },
      },
    });
  });

  it('creates the .claude directory if missing', () => {
    // tmpDir exists but .claude does not — no writeSettings() call.
    const result = saveMcpServer({ name: 'freshdir', type: 'stdio', command: 'node' });
    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(settingsFile())).toBe(true);
  });

  it('edits an existing entry in place', () => {
    writeSettings({
      mcpServers: {
        mylocal: { type: 'stdio', command: 'npx', args: ['old'] },
      },
    });
    const result = saveMcpServer(
      { name: 'mylocal', type: 'stdio', command: 'npx', args: ['new'] },
      'mylocal',
    );
    expect(result).toEqual({ ok: true });

    const onDisk = readSettings();
    const servers = onDisk.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(['mylocal']);
    expect(servers.mylocal).toEqual({ type: 'stdio', command: 'npx', args: ['new'] });
  });

  it('renames an entry: old key gone, new key present with same config', () => {
    writeSettings({
      mcpServers: {
        oldname: { type: 'http', url: 'https://example.com' },
      },
    });
    const result = saveMcpServer(
      { name: 'newname', type: 'http', url: 'https://example.com' },
      'oldname',
    );
    expect(result).toEqual({ ok: true });

    const onDisk = readSettings();
    const servers = onDisk.mcpServers as Record<string, unknown>;
    expect(servers).not.toHaveProperty('oldname');
    expect(servers.newname).toEqual({ type: 'http', url: 'https://example.com' });
  });

  it('rejects an invalid name', () => {
    writeSettings({ mcpServers: {} });
    const result = saveMcpServer({ name: 'bad name!', type: 'stdio', command: 'npx' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/letters, numbers/);
    // File must remain untouched.
    expect(readSettings().mcpServers).toEqual({});
  });

  it('rejects an empty name', () => {
    const result = saveMcpServer({ name: '   ', type: 'stdio', command: 'npx' });
    expect(result.ok).toBe(false);
  });

  it('rejects a name collision with a different existing entry', () => {
    writeSettings({
      mcpServers: {
        taken: { type: 'stdio', command: 'npx' },
      },
    });
    const result = saveMcpServer({ name: 'taken', type: 'http', url: 'https://example.com' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already exists/);

    // Original entry must be untouched.
    const onDisk = readSettings();
    expect(onDisk.mcpServers).toEqual({ taken: { type: 'stdio', command: 'npx' } });
  });

  it('allows saving over the same name when editing (previousName === name)', () => {
    writeSettings({
      mcpServers: {
        mine: { type: 'stdio', command: 'npx' },
      },
    });
    const result = saveMcpServer({ name: 'mine', type: 'stdio', command: 'other' }, 'mine');
    expect(result).toEqual({ ok: true });
    expect((readSettings().mcpServers as Record<string, unknown>).mine).toEqual({
      type: 'stdio',
      command: 'other',
    });
  });

  it('requires a command for stdio servers', () => {
    const result = saveMcpServer({ name: 'nocmd', type: 'stdio' });
    expect(result.ok).toBe(false);
  });

  it('requires a url for http/sse servers', () => {
    const result = saveMcpServer({ name: 'nourl', type: 'http' });
    expect(result.ok).toBe(false);
  });

  it('refuses to write when the existing file fails to parse', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ bad json {{', 'utf-8');
    const before = fs.readFileSync(settingsFile(), 'utf-8');

    const result = saveMcpServer({ name: 'newone', type: 'stdio', command: 'npx' });
    expect(result.ok).toBe(false);

    // File must be byte-for-byte untouched — we never clobber unparseable JSON.
    expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe(before);
  });

  it('leaves unrelated top-level keys and other mcpServers entries untouched', () => {
    writeSettings({
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      mcpServers: {
        obsidian_notes: { type: 'stdio', command: 'npx', args: ['-y', 'notes-mcp'] },
        internal: { type: 'sdk', name: 'internal-tools' },
      },
    });

    const result = saveMcpServer({ name: 'compass', type: 'http', url: 'https://compass.example.com' });
    expect(result).toEqual({ ok: true });

    const onDisk = readSettings();
    expect(onDisk.model).toBe('sonnet');
    expect(onDisk.permissionMode).toBe('acceptEdits');
    const servers = onDisk.mcpServers as Record<string, unknown>;
    expect(servers.obsidian_notes).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'notes-mcp'] });
    expect(servers.internal).toEqual({ type: 'sdk', name: 'internal-tools' });
    expect(servers.compass).toEqual({ type: 'http', url: 'https://compass.example.com' });
  });
});

// ---------------------------------------------------------------------------
// deleteMcpServer
// ---------------------------------------------------------------------------

describe('deleteMcpServer', () => {
  it('removes only the target key', () => {
    writeSettings({
      mcpServers: {
        keepme: { type: 'stdio', command: 'npx' },
        deleteme: { type: 'http', url: 'https://example.com' },
      },
    });
    const result = deleteMcpServer('deleteme');
    expect(result).toEqual({ ok: true });

    const onDisk = readSettings();
    const servers = onDisk.mcpServers as Record<string, unknown>;
    expect(servers).toEqual({ keepme: { type: 'stdio', command: 'npx' } });
  });

  it('is a no-op that still returns ok:true when the key is already absent', () => {
    writeSettings({ mcpServers: { other: { type: 'stdio', command: 'npx' } } });
    const before = readSettings();
    const result = deleteMcpServer('doesnotexist');
    expect(result).toEqual({ ok: true });
    expect(readSettings()).toEqual(before);
  });

  it('is a no-op when settings.json does not exist at all', () => {
    const result = deleteMcpServer('anything');
    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('leaves unrelated top-level keys and other mcpServers entries untouched', () => {
    writeSettings({
      model: 'sonnet',
      mcpServers: {
        target: { type: 'stdio', command: 'npx' },
        keeper: { type: 'sdk', name: 'internal' },
      },
    });
    const result = deleteMcpServer('target');
    expect(result).toEqual({ ok: true });

    const onDisk = readSettings();
    expect(onDisk.model).toBe('sonnet');
    expect(onDisk.mcpServers).toEqual({ keeper: { type: 'sdk', name: 'internal' } });
  });
});

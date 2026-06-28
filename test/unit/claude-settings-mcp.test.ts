import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readClaudeSettingsMcp } from '../../src/claudeSettingsMcp';

/**
 * Tests for the readClaudeSettingsMcp utility.
 *
 * Strategy: write a real settings.json to a temp dir, then point the function
 * at it by overriding HOME so path.join(os.homedir(), '.claude', 'settings.json')
 * resolves into our tmpdir.
 */

let tmpDir: string;
let origHome: string | undefined;

function writeSettings(content: unknown): void {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(content), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-mcp-test-'));
  origHome = process.env.HOME;
  // Override HOME so os.homedir() and path.join(os.homedir(), …) resolve into tmpDir.
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
// Happy-path shapes
// ---------------------------------------------------------------------------

describe('readClaudeSettingsMcp — basic shapes', () => {
  it('returns empty record when settings.json does not exist', () => {
    // No .claude/settings.json written — just tmpDir
    expect(readClaudeSettingsMcp()).toEqual({});
  });

  it('returns empty record when mcpServers key is absent', () => {
    writeSettings({ model: 'sonnet' });
    expect(readClaudeSettingsMcp()).toEqual({});
  });

  it('returns empty record when mcpServers is null', () => {
    writeSettings({ mcpServers: null });
    expect(readClaudeSettingsMcp()).toEqual({});
  });

  it('returns empty record when mcpServers is an array (invalid shape)', () => {
    writeSettings({ mcpServers: [] });
    expect(readClaudeSettingsMcp()).toEqual({});
  });

  it('returns empty record for empty mcpServers object', () => {
    writeSettings({ mcpServers: {} });
    expect(readClaudeSettingsMcp()).toEqual({});
  });

  it('returns http server config as-is', () => {
    writeSettings({
      mcpServers: {
        compass: { type: 'http', url: 'https://compass.example.com/api/mcp' },
      },
    });
    const result = readClaudeSettingsMcp();
    expect(result).toHaveProperty('compass');
    expect(result.compass).toMatchObject({ type: 'http', url: 'https://compass.example.com/api/mcp' });
  });

  it('returns sse server config', () => {
    writeSettings({
      mcpServers: {
        mysse: { type: 'sse', url: 'https://sse.example.com/events' },
      },
    });
    const result = readClaudeSettingsMcp();
    expect(result).toHaveProperty('mysse');
    expect(result.mysse).toMatchObject({ type: 'sse', url: 'https://sse.example.com/events' });
  });

  it('returns stdio server config (explicit type)', () => {
    writeSettings({
      mcpServers: {
        mylocal: { type: 'stdio', command: 'npx', args: ['my-mcp'] },
      },
    });
    const result = readClaudeSettingsMcp();
    expect(result).toHaveProperty('mylocal');
    expect(result.mylocal).toMatchObject({ type: 'stdio', command: 'npx', args: ['my-mcp'] });
  });

  it('returns stdio server config (implicit type — no type field)', () => {
    writeSettings({
      mcpServers: {
        nostdio: { command: 'node', args: ['server.js'] },
      },
    });
    const result = readClaudeSettingsMcp();
    expect(result).toHaveProperty('nostdio');
    expect(result.nostdio).toMatchObject({ command: 'node', args: ['server.js'] });
  });

  it('excludes sdk-type servers (they require a live instance)', () => {
    writeSettings({
      mcpServers: {
        sdkserver: { type: 'sdk', name: 'my-sdk-server' },
        httpserver: { type: 'http', url: 'https://ok.example.com' },
      },
    });
    const result = readClaudeSettingsMcp();
    expect(result).not.toHaveProperty('sdkserver');
    expect(result).toHaveProperty('httpserver');
  });

  it('skips entries with unknown types', () => {
    writeSettings({
      mcpServers: {
        weird: { type: 'grpc', url: 'grpc://example.com' },
        fine: { type: 'http', url: 'https://example.com' },
      },
    });
    const result = readClaudeSettingsMcp();
    expect(result).not.toHaveProperty('weird');
    expect(result).toHaveProperty('fine');
  });

  it('skips non-object entries', () => {
    writeSettings({
      mcpServers: {
        notAnObject: 'https://example.com',
        alsoNot: 42,
        fine: { type: 'http', url: 'https://example.com' },
      },
    });
    const result = readClaudeSettingsMcp();
    expect(Object.keys(result)).toEqual(['fine']);
  });

  it('returns multiple servers', () => {
    writeSettings({
      mcpServers: {
        helio: { type: 'http', url: 'https://helios.example.com/api/mcp' },
        compass: { type: 'http', url: 'https://compass.example.com/api/mcp' },
      },
    });
    const result = readClaudeSettingsMcp();
    expect(Object.keys(result).sort()).toEqual(['compass', 'helio']);
  });
});

// ---------------------------------------------------------------------------
// Env var placeholder resolution
// ---------------------------------------------------------------------------

describe('readClaudeSettingsMcp — env var resolution', () => {
  it('resolves ${VAR} placeholders in header values using extraEnv', () => {
    writeSettings({
      mcpServers: {
        compass: {
          type: 'http',
          url: 'https://compass.example.com/api/mcp',
          headers: { Authorization: 'Bearer ${COMPASS_API_KEY}' },
        },
      },
    });
    const result = readClaudeSettingsMcp({ COMPASS_API_KEY: 'test-token-123' });
    expect((result.compass as Record<string, unknown>).headers).toEqual({
      Authorization: 'Bearer test-token-123',
    });
  });

  it('resolves ${VAR} placeholders in url strings', () => {
    writeSettings({
      mcpServers: {
        dynamic: {
          type: 'http',
          url: 'https://${MCP_HOST}/api/mcp',
        },
      },
    });
    const result = readClaudeSettingsMcp({ MCP_HOST: 'mcp.internal.example.com' });
    expect((result.dynamic as Record<string, unknown>).url).toBe('https://mcp.internal.example.com/api/mcp');
  });

  it('resolves ${VAR} in stdio env field', () => {
    writeSettings({
      mcpServers: {
        cliserver: {
          type: 'stdio',
          command: 'my-mcp-server',
          env: { API_TOKEN: '${MY_SECRET_TOKEN}' },
        },
      },
    });
    const result = readClaudeSettingsMcp({ MY_SECRET_TOKEN: 'secret-value' });
    const cliserver = result.cliserver as Record<string, unknown>;
    expect((cliserver.env as Record<string, string>).API_TOKEN).toBe('secret-value');
  });

  it('replaces unresolved ${VAR} with empty string', () => {
    writeSettings({
      mcpServers: {
        compass: {
          type: 'http',
          url: 'https://compass.example.com',
          headers: { Authorization: 'Bearer ${NONEXISTENT_VAR}' },
        },
      },
    });
    // Ensure the var is not in process.env
    delete process.env.NONEXISTENT_VAR;
    const result = readClaudeSettingsMcp({});
    expect((result.compass as Record<string, unknown>).headers).toEqual({
      Authorization: 'Bearer ',
    });
  });

  it('extraEnv takes precedence over process.env for placeholder resolution', () => {
    process.env.OVERRIDDEN_KEY = 'from-process-env';
    writeSettings({
      mcpServers: {
        srv: {
          type: 'http',
          url: 'https://example.com',
          headers: { 'X-Key': '${OVERRIDDEN_KEY}' },
        },
      },
    });
    const result = readClaudeSettingsMcp({ OVERRIDDEN_KEY: 'from-extra-env' });
    expect((result.srv as Record<string, unknown>).headers).toEqual({
      'X-Key': 'from-extra-env',
    });
    delete process.env.OVERRIDDEN_KEY;
  });
});

// ---------------------------------------------------------------------------
// Symlink support
// ---------------------------------------------------------------------------

describe('readClaudeSettingsMcp — symlink support', () => {
  it('follows a symlink to the real settings file', () => {
    // Write the real file somewhere else
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-mcp-real-'));
    const realFile = path.join(realDir, 'personal.json');
    fs.writeFileSync(
      realFile,
      JSON.stringify({
        mcpServers: { via_symlink: { type: 'http', url: 'https://symlinked.example.com' } },
      }),
      'utf-8',
    );

    // Create the symlink at ~/.claude/settings.json → realFile
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.symlinkSync(realFile, path.join(claudeDir, 'settings.json'));

    const result = readClaudeSettingsMcp();
    expect(result).toHaveProperty('via_symlink');
    expect((result.via_symlink as Record<string, unknown>).url).toBe('https://symlinked.example.com');

    fs.rmSync(realDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe('readClaudeSettingsMcp — error resilience', () => {
  it('returns empty record for malformed JSON', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ bad json {{', 'utf-8');
    expect(readClaudeSettingsMcp()).toEqual({});
  });

  it('returns empty record for empty file', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '', 'utf-8');
    expect(readClaudeSettingsMcp()).toEqual({});
  });

  it('returns empty record when settings.json is a directory', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    // Create settings.json as a directory instead of a file
    fs.mkdirSync(path.join(claudeDir, 'settings.json'), { recursive: true });
    expect(readClaudeSettingsMcp()).toEqual({});
  });
});

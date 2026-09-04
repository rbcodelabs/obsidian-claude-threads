import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/types';

const root = resolve(__dirname, '../..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('Agent Threads product identity', () => {
  it('uses Agent Threads as the fresh-install vault folder', () => {
    expect(DEFAULT_SETTINGS.vaultFolder).toBe('Agent Threads');
  });

  it('preserves loaded legacy vault folders and paths', () => {
    const legacy = { vaultFolder: 'Claude', noteFile: 'Claude/old-thread.md' };
    const merged = Object.assign({}, DEFAULT_SETTINGS, legacy);
    expect(merged.vaultFolder).toBe('Claude');
    expect(merged.noteFile).toBe('Claude/old-thread.md');
  });

  it('creates the new welcome guide while recognizing the legacy guide', () => {
    const main = source('src/main.ts');
    const identity = source('src/productIdentity.ts');
    expect(identity).toContain('Getting Started with Agent Threads.md');
    expect(identity).toContain('Getting Started with Claude Threads.md');
    expect(main).toContain('DIAGNOSTICS_FOLDER');
    expect(identity).toContain('agent-threads-diagnostics');
  });

  it('keeps stable compatibility identifiers unchanged', () => {
    const manifest = JSON.parse(source('manifest.json')) as { id: string; name: string };
    const main = source('src/main.ts');
    const tools = source('src/ObsidianTools.ts');
    const sessions = source('src/ThreadSession.ts');
    expect(manifest).toMatchObject({ id: 'claude-threads', name: 'Agent Threads' });
    expect(main).toContain("const VIEW_TYPE = 'claude-threads:chat'");
    expect(main).toContain("id: 'open-claude-threads'");
    expect(tools).toContain("name: 'claude_threads'");
    expect(sessions).toContain('mcp__claude_threads__enter_worktree');
  });
});

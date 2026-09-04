import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/types';
import * as identity from '../../src/productIdentity';

const root = resolve(__dirname, '../..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('Agent Threads product identity', () => {
  it('uses Agent Threads as the fresh-install vault folder', () => {
    expect(DEFAULT_SETTINGS.vaultFolder).toBe('Agent Threads');
  });

  it('preserves loaded legacy vault folders, note/log paths, and attachment paths', () => {
    const legacy = {
      vaultFolder: 'Claude',
      threads: [{
        noteFile: 'Claude/old-thread.md',
        rawLogPath: 'Claude/logs/thread.jsonl',
        messages: [{ images: [{ path: 'Claude/attachments/thread/image.png' }] }],
      }],
    };
    const merge = (identity as unknown as { mergePersistedSettings: <T>(defaults: T, saved: Partial<T>) => T }).mergePersistedSettings;
    const merged = merge(DEFAULT_SETTINGS, legacy as never);
    expect(merged.vaultFolder).toBe('Claude');
    expect(merged.threads[0]?.noteFile).toBe('Claude/old-thread.md');
    expect(merged.threads[0]?.rawLogPath).toBe('Claude/logs/thread.jsonl');
    expect(merged.threads[0]?.messages[0]?.images?.[0]?.path).toBe('Claude/attachments/thread/image.png');
  });

  it('creates the new welcome guide while recognizing the legacy guide', () => {
    const main = source('src/main.ts');
    const identity = source('src/productIdentity.ts');
    expect(identity).toContain('Getting Started with Agent Threads.md');
    expect(identity).toContain('Getting Started with Claude Threads.md');
    expect(main).toContain('DIAGNOSTICS_FOLDER');
    expect(identity).toContain('agent-threads-diagnostics');
  });

  it('opens an existing legacy guide instead of creating a duplicate', () => {
    const paths = identity.welcomeGuidePaths('Claude');
    const select = (identity as unknown as {
      selectWelcomeGuidePath: (folder: string, exists: (path: string) => boolean) => { path: string; shouldCreate: boolean };
    }).selectWelcomeGuidePath;
    expect(select('Claude', path => path === paths.legacy)).toEqual({ path: paths.legacy, shouldCreate: false });
  });

  it('keeps stable compatibility identifiers unchanged', () => {
    const manifest = JSON.parse(source('manifest.json')) as { id: string; name: string };
    const main = source('src/main.ts');
    const sessions = source('src/ThreadSession.ts');
    expect(manifest).toMatchObject({ id: 'claude-threads', name: 'Agent Threads' });
    expect(main).toContain("const VIEW_TYPE = 'claude-threads:chat'");
    expect(main).toContain("id: 'open-claude-threads'");
    expect(identity.LEGACY_MCP_SERVER_NAME).toBe('claude_threads');
    expect(sessions).toContain('mcp__claude_threads__enter_worktree');
  });
});

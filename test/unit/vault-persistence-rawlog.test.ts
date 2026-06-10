import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import { VaultPersistence } from '../../src/VaultPersistence';
import type { Thread } from '../../src/types';

// ---------------------------------------------------------------------------
// Mock vault that supports the read+write surface saveThread/loadAllThreads use,
// so we can verify the raw_log frontmatter survives a full save → load round trip.
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
    if (key) fm[key] = val;
  }
  return fm;
}

function makeApp() {
  const contents: Record<string, string> = {};
  const folders = new Set<string>();
  return {
    contents,
    vault: {
      getAbstractFileByPath: (p: string) =>
        p in contents ? new TFile(p) : (folders.has(p) ? { path: p } : null),
      createFolder: async (p: string) => { folders.add(p); },
      create: async (p: string, content: string) => { contents[p] = content; return new TFile(p); },
      modify: async (file: { path: string }, content: string) => { contents[file.path] = content; },
      rename: async (file: { path: string }, to: string) => {
        contents[to] = contents[file.path]; delete contents[file.path];
      },
      read: async (file: { path: string }) => contents[file.path],
      getMarkdownFiles: () => Object.keys(contents).map((path) => new TFile(path)),
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => {
        const fm = parseFrontmatter(contents[file.path] ?? '');
        return fm ? { frontmatter: fm } : null;
      },
    },
  };
}

function baseThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-uuid-1',
    title: 'Raw Log Test',
    cwd: '/some/repo',
    messages: [
      { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'hi there', timestamp: 2 },
    ],
    createdAt: new Date('2026-01-15T10:00:00Z').getTime(),
    updatedAt: new Date('2026-01-15T10:05:00Z').getTime(),
    status: 'waiting',
    ...overrides,
  };
}

describe('VaultPersistence raw_log frontmatter', () => {
  const FOLDER = 'Claude';

  it('writes the raw_log path into frontmatter when the thread has one', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, FOLDER);
    const thread = baseThread({ rawLogPath: 'Claude/logs/thread-uuid-1.jsonl' });

    const file = await vp.saveThread(thread);

    expect(app.contents[file]).toContain('raw_log: Claude/logs/thread-uuid-1.jsonl');
  });

  it('omits the raw_log line entirely when the thread has none', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, FOLDER);

    const file = await vp.saveThread(baseThread());

    expect(app.contents[file]).not.toContain('raw_log:');
  });

  it('round-trips: a saved raw_log path is parsed back by loadAllThreads', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, FOLDER);
    await vp.saveThread(baseThread({ rawLogPath: 'Claude/logs/thread-uuid-1.jsonl' }));

    const loaded = await vp.loadAllThreads();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].rawLogPath).toBe('Claude/logs/thread-uuid-1.jsonl');
  });

  it('round-trips a custom vault folder in the raw_log path', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, 'My Threads');
    await vp.saveThread(baseThread({ rawLogPath: 'My Threads/logs/thread-uuid-1.jsonl' }));

    const loaded = await vp.loadAllThreads();
    expect(loaded[0].rawLogPath).toBe('My Threads/logs/thread-uuid-1.jsonl');
  });
});

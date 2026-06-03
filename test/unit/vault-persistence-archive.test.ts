import { describe, it, expect, beforeEach } from 'vitest';
import { VaultPersistence } from '../../src/VaultPersistence';

// ---------------------------------------------------------------------------
// Minimal vault mock
// ---------------------------------------------------------------------------

/**
 * Files are keyed by vault-relative path. The object is mutated in place by
 * modify() so assertions can inspect the final content after the method runs.
 */
function makeApp(files: Record<string, string>) {
  const fileContents: Record<string, string> = { ...files };

  /** Parse simple key: value YAML frontmatter from a file content string. */
  function parseFrontmatter(content: string): Record<string, string> | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const fm: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim().replace(/^"(.*)"$/, '$1');
      if (key) fm[key] = val;
    }
    return fm;
  }

  return {
    vault: {
      getMarkdownFiles: () =>
        Object.keys(fileContents).map((path) => ({ path })),
      read: async (file: { path: string }) => fileContents[file.path],
      modify: async (file: { path: string }, content: string) => {
        fileContents[file.path] = content;
      },
      // Return the live fileContents so tests can inspect it after the call
      _contents: fileContents,
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => {
        const content = fileContents[file.path];
        if (!content) return null;
        const frontmatter = parseFrontmatter(content);
        return frontmatter ? { frontmatter } : null;
      },
    },
  };
}

/** Builds a realistic frontmatter block for a thread note. */
function threadNote(threadId: string, status: string, extra = ''): string {
  return [
    '---',
    `thread_id: ${threadId}`,
    `status: ${status}`,
    `title: "Test Thread"`,
    `cwd: /some/cwd`,
    extra,
    '---',
    '',
    '# Test Thread',
    '',
    '**You:**',
    '',
    'hello',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VaultPersistence.archiveOrphanedNotes', () => {
  const FOLDER = 'Claude';

  // Helper: build a VaultPersistence instance wired to the given fake vault.
  function makeVP(files: Record<string, string>) {
    const app = makeApp(files);
    const vp = new VaultPersistence(app as any, FOLDER);
    return { vp, contents: app.vault._contents };
  }

  it('archives an orphaned waiting note and returns count 1', async () => {
    // Arrange: thread abc is NOT in activeThreadIds
    const path = `${FOLDER}/2026-01-01-test.md`;
    const { vp, contents } = makeVP({
      [path]: threadNote('abc', 'waiting'),
    });

    // Act
    const count = await vp.archiveOrphanedNotes(new Set(['other-thread']));

    // Assert
    expect(count).toBe(1);
    expect(contents[path]).toContain('status: archived');
    expect(contents[path]).not.toContain('status: waiting');
  });

  it('leaves an active thread note unchanged and returns count 0', async () => {
    // Arrange: thread abc IS in activeThreadIds
    const path = `${FOLDER}/2026-01-01-active.md`;
    const original = threadNote('abc', 'waiting');
    const { vp, contents } = makeVP({ [path]: original });

    // Act
    const count = await vp.archiveOrphanedNotes(new Set(['abc']));

    // Assert
    expect(count).toBe(0);
    expect(contents[path]).toBe(original); // unchanged
  });

  it('leaves an already-archived note unchanged and returns count 0', async () => {
    // An archived note must not be touched even if the thread_id is missing
    // from activeThreadIds — the status gate `status !== 'waiting'` protects it.
    const path = `${FOLDER}/2026-01-01-archived.md`;
    const original = threadNote('abc', 'archived');
    const { vp, contents } = makeVP({ [path]: original });

    // Act
    const count = await vp.archiveOrphanedNotes(new Set());

    // Assert
    expect(count).toBe(0);
    expect(contents[path]).toBe(original);
  });

  it('leaves a note with no thread_id frontmatter field unchanged and returns count 0', async () => {
    const path = `${FOLDER}/2026-01-01-non-thread.md`;
    const noThreadNote = ['---', 'status: waiting', 'title: "Random note"', '---', '', '# Random note'].join('\n');
    const { vp, contents } = makeVP({ [path]: noThreadNote });

    const count = await vp.archiveOrphanedNotes(new Set());

    expect(count).toBe(0);
    expect(contents[path]).toBe(noThreadNote);
  });

  it('ignores files outside the plugin folder', async () => {
    // A file in a different vault folder must not be touched even if it has
    // matching frontmatter — the folder-prefix filter guards this.
    const outsidePath = 'Daily/2026-01-01.md';
    const insidePath = `${FOLDER}/2026-01-01-thread.md`;
    const { vp, contents } = makeVP({
      [outsidePath]: threadNote('xyz', 'waiting'),
      [insidePath]: threadNote('active-one', 'waiting'),
    });

    const count = await vp.archiveOrphanedNotes(new Set(['active-one']));

    expect(count).toBe(0);
    expect(contents[outsidePath]).toContain('status: waiting'); // untouched
  });

  it('handles multiple files — archives only orphaned waiting ones', async () => {
    // Three files in the folder:
    //   orphan-a: orphaned, waiting  → should be archived
    //   active-b: active, waiting    → must not change
    //   done-c:   orphaned, archived → must not change (already done)
    const paths = {
      orphanA: `${FOLDER}/2026-01-01-orphan-a.md`,
      activeB: `${FOLDER}/2026-01-02-active-b.md`,
      doneC: `${FOLDER}/2026-01-03-done-c.md`,
    };
    const { vp, contents } = makeVP({
      [paths.orphanA]: threadNote('orphan-a', 'waiting'),
      [paths.activeB]: threadNote('active-b', 'waiting'),
      [paths.doneC]: threadNote('done-c', 'archived'),
    });

    const count = await vp.archiveOrphanedNotes(new Set(['active-b']));

    expect(count).toBe(1);
    expect(contents[paths.orphanA]).toContain('status: archived');
    expect(contents[paths.activeB]).toContain('status: waiting'); // untouched
    expect(contents[paths.doneC]).toContain('status: archived'); // already was archived, unchanged
  });

  it('returns 0 when the folder contains no files', async () => {
    const { vp } = makeVP({});

    const count = await vp.archiveOrphanedNotes(new Set());

    expect(count).toBe(0);
  });

  it('returns 0 when activeThreadIds is empty but all notes are already archived', async () => {
    const { vp } = makeVP({
      [`${FOLDER}/a.md`]: threadNote('a', 'archived'),
      [`${FOLDER}/b.md`]: threadNote('b', 'archived'),
    });

    const count = await vp.archiveOrphanedNotes(new Set());

    expect(count).toBe(0);
  });

  it('replaces only the status line — does not corrupt the rest of the file content', async () => {
    const path = `${FOLDER}/2026-01-01-check.md`;
    const original = threadNote('xyz', 'waiting');
    const { vp, contents } = makeVP({ [path]: original });

    await vp.archiveOrphanedNotes(new Set());

    const updated = contents[path];
    // The status line is replaced
    expect(updated).toContain('status: archived');
    // Everything else is intact
    expect(updated).toContain('thread_id: xyz');
    expect(updated).toContain('title: "Test Thread"');
    expect(updated).toContain('# Test Thread');
  });
});

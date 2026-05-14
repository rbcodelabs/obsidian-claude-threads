import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

/**
 * Unit tests for the focusEditedFiles() logic.
 *
 * The method has three responsibilities:
 *   1. Resolve absolute file paths against vaultBase to get vault-relative paths.
 *   2. Detach all existing markdown leaves.
 *   3. Reopen only the vault files, first using getLeaf(false), subsequent using getLeaf('tab').
 *
 * Non-vault paths (absolute paths outside vaultBase) are silently skipped.
 * If nothing qualifies, a Notice is shown and no leaves are touched.
 *
 * We test the pure logic extracted into a helper that mirrors the real method,
 * keeping the tests free of Obsidian DOM dependencies.
 */

const VAULT_BASE = '/Users/test/vault';
const SEP = path.sep;

/** Mirrors the path-resolution logic from focusEditedFiles(). */
function resolveVaultRelative(editedFiles: string[], vaultBase: string): string[] {
  const relPaths: string[] = [];
  for (const filePath of editedFiles) {
    if (vaultBase && filePath.startsWith(vaultBase + SEP)) {
      relPaths.push(filePath.slice(vaultBase.length + 1));
    }
  }
  return relPaths;
}

/** Minimal fake leaf used in workspace simulation. */
function makeLeaf(viewType = 'markdown') {
  return {
    view: { getViewType: () => viewType },
    detach: vi.fn(),
    openFile: vi.fn().mockResolvedValue(undefined),
  };
}

/** Simulate iterateAllLeaves + detach + reopen logic. */
function simulateFocus(
  editedFiles: string[],
  vaultBase: string,
  existingLeaves: ReturnType<typeof makeLeaf>[],
  getFile: (rel: string) => object | null,
) {
  const relPaths = resolveVaultRelative(editedFiles, vaultBase);
  if (relPaths.length === 0) return { noticed: true, detached: [], opened: [] };

  const detached: ReturnType<typeof makeLeaf>[] = [];
  for (const leaf of existingLeaves) {
    if (leaf.view.getViewType() === 'markdown') {
      leaf.detach();
      detached.push(leaf);
    }
  }

  const opened: { rel: string; mode: false | 'tab' }[] = [];
  for (let i = 0; i < relPaths.length; i++) {
    const file = getFile(relPaths[i]);
    if (!file) continue;
    opened.push({ rel: relPaths[i], mode: i === 0 ? false : 'tab' });
  }

  return { noticed: false, detached, opened };
}

describe('focusEditedFiles — path resolution', () => {
  it('resolves absolute vault paths to relative paths', () => {
    const files = [`${VAULT_BASE}${SEP}Daily${SEP}2026-05-14.md`];
    expect(resolveVaultRelative(files, VAULT_BASE)).toEqual([`Daily${SEP}2026-05-14.md`]);
  });

  it('skips paths that are outside the vault', () => {
    const files = ['/tmp/some-external-file.md'];
    expect(resolveVaultRelative(files, VAULT_BASE)).toEqual([]);
  });

  it('handles a mix of vault and non-vault paths', () => {
    const files = [
      `${VAULT_BASE}${SEP}Notes${SEP}foo.md`,
      '/tmp/external.md',
      `${VAULT_BASE}${SEP}Daily${SEP}bar.md`,
    ];
    expect(resolveVaultRelative(files, VAULT_BASE)).toEqual([
      `Notes${SEP}foo.md`,
      `Daily${SEP}bar.md`,
    ]);
  });

  it('returns empty array when editedFiles is empty', () => {
    expect(resolveVaultRelative([], VAULT_BASE)).toEqual([]);
  });

  it('does not partially match path prefixes', () => {
    // A path that starts with the vaultBase string but not followed by sep
    const imposter = `${VAULT_BASE}-other${SEP}file.md`;
    expect(resolveVaultRelative([imposter], VAULT_BASE)).toEqual([]);
  });
});

describe('focusEditedFiles — leaf management', () => {
  const vaultFile = `${VAULT_BASE}${SEP}Notes${SEP}a.md`;
  const fileMap: Record<string, object> = { [`Notes${SEP}a.md`]: { path: 'Notes/a.md' } };
  const getFile = (rel: string) => fileMap[rel] ?? null;

  it('detaches all existing markdown leaves', () => {
    const leaves = [makeLeaf('markdown'), makeLeaf('markdown')];
    const { detached } = simulateFocus([vaultFile], VAULT_BASE, leaves, getFile);
    expect(detached).toHaveLength(2);
    for (const leaf of detached) expect(leaf.detach).toHaveBeenCalledOnce();
  });

  it('does not detach non-markdown leaves', () => {
    const markdownLeaf = makeLeaf('markdown');
    const pdfLeaf = makeLeaf('pdf');
    const { detached } = simulateFocus([vaultFile], VAULT_BASE, [markdownLeaf, pdfLeaf], getFile);
    expect(detached).toHaveLength(1);
    expect(pdfLeaf.detach).not.toHaveBeenCalled();
  });

  it('opens first file with getLeaf(false)', () => {
    const files = [`${VAULT_BASE}${SEP}Notes${SEP}a.md`];
    const { opened } = simulateFocus(files, VAULT_BASE, [], getFile);
    expect(opened[0].mode).toBe(false);
  });

  it('opens subsequent files with getLeaf("tab")', () => {
    const multiFileMap: Record<string, object> = {
      [`Notes${SEP}a.md`]: {},
      [`Notes${SEP}b.md`]: {},
      [`Notes${SEP}c.md`]: {},
    };
    const files = [
      `${VAULT_BASE}${SEP}Notes${SEP}a.md`,
      `${VAULT_BASE}${SEP}Notes${SEP}b.md`,
      `${VAULT_BASE}${SEP}Notes${SEP}c.md`,
    ];
    const { opened } = simulateFocus(files, VAULT_BASE, [], (r) => multiFileMap[r] ?? null);
    expect(opened[0].mode).toBe(false);
    expect(opened[1].mode).toBe('tab');
    expect(opened[2].mode).toBe('tab');
  });

  it('shows a notice and touches no leaves when no vault files qualify', () => {
    const leaves = [makeLeaf('markdown')];
    const { noticed, detached } = simulateFocus(['/tmp/external.md'], VAULT_BASE, leaves, getFile);
    expect(noticed).toBe(true);
    expect(detached).toHaveLength(0);
    expect(leaves[0].detach).not.toHaveBeenCalled();
  });

  it('skips files that do not exist in the vault', () => {
    const files = [
      `${VAULT_BASE}${SEP}Notes${SEP}a.md`,    // exists
      `${VAULT_BASE}${SEP}Notes${SEP}gone.md`, // does not exist in fileMap
    ];
    const { opened } = simulateFocus(files, VAULT_BASE, [], getFile);
    expect(opened).toHaveLength(1);
    expect(opened[0].rel).toBe(`Notes${SEP}a.md`);
  });
});

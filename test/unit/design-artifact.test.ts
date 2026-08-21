import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  artifactIdForThread,
  buildDesignManifest,
  designArtifactRoot,
  designKickoffMessage,
  designTitle,
  ensureDesignArtifact,
  type DesignArtifactFs,
} from '../../src/designArtifact';

describe('design artifact contract', () => {
  it('derives a portable stable artifact id and root from the thread', () => {
    expect(artifactIdForThread('ABC:thread/unsafe')).toBe('design-abc-thread-unsafe');
    expect(designArtifactRoot('/vault', 'ABC')).toBe(path.join('/vault', '.geode', 'artifacts', 'design-abc'));
  });

  it('builds the exact static, networkless v1 manifest', () => {
    expect(buildDesignManifest('thread-1', 'Checkout concept')).toEqual({
      schemaVersion: 1,
      id: 'design-thread-1',
      title: 'Checkout concept',
      entry: 'index.html',
      runtime: 'static',
      createdByThreadId: 'thread-1',
      viewport: { preset: 'desktop', width: 1440, height: 900 },
      permissions: { network: 'none', clipboard: false },
    });
  });

  it('bounds the title to the shared manifest limit', () => {
    expect(designTitle(`# ${'x'.repeat(140)}`).length).toBeLessThanOrEqual(120);
    expect(designTitle('')).toBe('Design artifact');
  });

  it('creates one zero-install scaffold and persists thread metadata', async () => {
    const writes = new Map<string, string>();
    const fileFs: DesignArtifactFs = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (target, data) => { writes.set(target, data); }),
    };
    const thread = { id: 'thread-1', artifacts: undefined };
    const artifact = await ensureDesignArtifact(thread, '/vault', 'Checkout concept', 123, fileFs);

    expect(artifact.root).toBe(path.join('/vault', '.geode', 'artifacts', 'design-thread-1'));
    expect(thread.artifacts).toEqual([artifact]);
    expect([...writes.keys()].map((target) => path.basename(target)).sort()).toEqual(['app.js', 'artifact.json', 'index.html', 'styles.css']);
    expect(writes.get(path.join(artifact.root, 'index.html'))).toContain('<script src="app.js"></script>');
    expect(writes.get(path.join(artifact.root, 'artifact.json'))).toContain('"network": "none"');
  });

  it('reuses the canonical artifact without rewriting accepted source', async () => {
    const existing = {
      id: 'design-thread-1', kind: 'design-static' as const, title: 'Existing', root: '/artifact',
      manifestPath: '/artifact/artifact.json', entryPath: '/artifact/index.html', createdAt: 10, updatedAt: 10,
    };
    const thread = { id: 'thread-1', artifacts: [existing] };
    const fileFs = { mkdir: vi.fn(), writeFile: vi.fn() } as unknown as DesignArtifactFs;
    expect(await ensureDesignArtifact(thread, '/vault', 'Revision', 20, fileFs)).toBe(existing);
    expect(existing.updatedAt).toBe(20);
    expect(fileFs.writeFile).not.toHaveBeenCalled();
  });

  it('builds harness-neutral instructions with the artifact constraints', () => {
    const message = designKickoffMessage({
      id: 'design-t', kind: 'design-static', title: 'T', root: '/artifact', manifestPath: '/artifact/artifact.json',
      entryPath: '/artifact/index.html', createdAt: 1, updatedAt: 1,
    }, 'Make a dashboard');
    expect(message).toContain('/artifact');
    expect(message).toContain('Make a dashboard');
    expect(message).toContain('Do not install packages');
    expect(message).toContain('Inline JavaScript is blocked');
    expect(message).not.toContain('Claude Code');
  });
});

/**
 * Regression tests for AttachmentWriter's host-write fallback ladder.
 *
 * The bug these exist to catch: the plugin runs inside Geode as well as
 * Obsidian, and Geode's `FileSystemAdapter` shim implements only
 * `getBasePath` / `getName` / `getResourcePath` / `exists`. The old code
 * passed its `instanceof FileSystemAdapter` guard there, then called
 * `adapter.mkdir(...)`, which is `undefined` under Geode, so a TypeError
 * unwound out of `write()`, the catch swallowed it, and it returned null. Every
 * pasted image and every tool-result image silently stayed inline as base64 in
 * data.json, which is exactly the bloat ADR-0003 removed.
 *
 * So each rung is asserted independently, plus the "no rung available" case
 * that must return null rather than throw into the session hot path.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileSystemAdapter, TFile } from 'obsidian';
import type { App } from 'obsidian';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AttachmentWriter } from '../../src/AttachmentWriter';

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]).toString('base64');
const EXPECTED_REL = 'Claude/attachments/thread-1/msg-1-0.png';

const tempRoots: string[] = [];
function makeTempVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-writer-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

/**
 * A `FileSystemAdapter` instance (so the `instanceof` desktop guard passes)
 * carrying only the methods a given host actually implements.
 */
function makeAdapter(methods: Record<string, unknown>): unknown {
  // Object.create keeps `instanceof FileSystemAdapter` true (the desktop guard)
  // while letting each test declare exactly which methods the host implements.
  // The inherited getBasePath/getResourcePath are shadowed to undefined so the
  // obsidian mock's own stubs cannot leak in and mask a missing capability.
  const adapter = Object.create(FileSystemAdapter.prototype) as Record<string, unknown>;
  adapter.getBasePath = undefined;
  adapter.getResourcePath = undefined;
  return Object.assign(adapter, methods);
}

function makeApp(vault: Record<string, unknown>, adapter: unknown): App {
  return { vault: { adapter, ...vault } } as unknown as App;
}

/** An in-memory directory tree backing exists()/mkdir() pairs. */
function makeDirTree() {
  const dirs = new Set<string>();
  return {
    dirs,
    exists: vi.fn(async (p: string) => dirs.has(p)),
    mkdir: vi.fn(async (p: string) => { dirs.add(p); }),
  };
}

function writerFor(app: App, hostWindow: Record<string, unknown> = {}) {
  return new AttachmentWriter(() => app, () => 'Claude', () => hostWindow);
}

describe('AttachmentWriter fallback ladder', () => {
  it('rung 2: uses the Obsidian vault API when it is present and no host bridge exists', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const modifyBinary = vi.fn(async () => {});
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp({ getAbstractFileByPath: () => null, createBinary, modifyBinary }, adapter);

    const result = await writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64);

    expect(result).toBe(EXPECTED_REL);
    expect(createBinary).toHaveBeenCalledTimes(1);
    expect(createBinary.mock.calls[0]![0]).toBe(EXPECTED_REL);
    expect(Buffer.from(createBinary.mock.calls[0]![1] as ArrayBuffer).toString('base64')).toBe(PNG_BASE64);
    expect(modifyBinary).not.toHaveBeenCalled();
    // Every ancestor was created, not just the leaf.
    expect([...tree.dirs]).toEqual(['Claude', 'Claude/attachments', 'Claude/attachments/thread-1']);
  });

  it('rung 2: overwrites an existing cached file through modifyBinary rather than createBinary', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const modifyBinary = vi.fn(async () => {});
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp(
      { getAbstractFileByPath: (p: string) => (p === EXPECTED_REL ? new TFile(p) : null), createBinary, modifyBinary },
      adapter,
    );

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64)).resolves.toBe(EXPECTED_REL);
    expect(modifyBinary).toHaveBeenCalledTimes(1);
    expect(createBinary).not.toHaveBeenCalled();
  });

  it('rung 1: uses window.geode.writeBinary when the vault API is absent', async () => {
    // Geode's real shim: exists() but no mkdir, no createBinary, no writeBinary.
    const adapter = makeAdapter({ exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);
    const writeBinary = vi.fn(async () => {});

    const result = await writerFor(app, { geode: { writeBinary } })
      .write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64);

    expect(result).toBe(EXPECTED_REL);
    expect(writeBinary).toHaveBeenCalledWith(EXPECTED_REL, PNG_BASE64);
  });

  it('rung 1 wins over rung 2: the host bridge is preferred whenever it exists', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp({ getAbstractFileByPath: () => null, createBinary }, adapter);
    const writeBinary = vi.fn(async () => {});

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);

    expect(writeBinary).toHaveBeenCalledTimes(1);
    expect(createBinary).not.toHaveBeenCalled();
  });

  it('ignores a window.geode that exists but has no writeBinary, falling through to rung 2', async () => {
    const tree = makeDirTree();
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp({ getAbstractFileByPath: () => null, createBinary }, adapter);

    await expect(
      writerFor(app, { geode: { acquirePowerSaveBlocker: () => {} } })
        .write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);
    expect(createBinary).toHaveBeenCalledTimes(1);
  });

  it('rung 3: falls back to fs when both the host bridge and the vault API are absent', async () => {
    // This is the live Geode shape today: exists() and getBasePath(), nothing else.
    const root = makeTempVault();
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    const result = await writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64);

    expect(result).toBe(EXPECTED_REL);
    const abs = path.join(root, EXPECTED_REL);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs).toString('base64')).toBe(PNG_BASE64);
  });

  it('rung 3: also catches a vault API that exists but throws', async () => {
    const root = makeTempVault();
    const tree = makeDirTree();
    const adapter = makeAdapter({ getBasePath: () => root, exists: tree.exists, mkdir: tree.mkdir });
    const app = makeApp(
      {
        getAbstractFileByPath: () => null,
        createBinary: vi.fn(async () => { throw new Error('createBinary exploded'); }),
      },
      adapter,
    );

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64))
      .resolves.toBe(EXPECTED_REL);
    expect(fs.readFileSync(path.join(root, EXPECTED_REL)).toString('base64')).toBe(PNG_BASE64);
  });

  it('rung 1 failure degrades to a lower rung instead of aborting the write', async () => {
    const root = makeTempVault();
    const adapter = makeAdapter({ getBasePath: () => root, exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);
    const writeBinary = vi.fn(async () => { throw new Error('IPC channel not registered'); });

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBe(EXPECTED_REL);
    expect(fs.existsSync(path.join(root, EXPECTED_REL))).toBe(true);
  });

  it('returns null without throwing when no rung is available', async () => {
    // No geode bridge, no vault binary methods, no usable vault root.
    const adapter = makeAdapter({ exists: async () => false });
    const app = makeApp({ getAbstractFileByPath: () => null }, adapter);

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64)).resolves.toBeNull();
  });

  it('returns null off desktop without consulting any rung', async () => {
    const writeBinary = vi.fn(async () => {});
    // A plain-object adapter fails the `instanceof FileSystemAdapter` guard.
    const app = makeApp({ getAbstractFileByPath: () => null }, { getBasePath: () => '/x' });

    await expect(
      writerFor(app, { geode: { writeBinary } }).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64),
    ).resolves.toBeNull();
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('ensureDir prefers vault.createFolder when the adapter has no mkdir', async () => {
    const tree = makeDirTree();
    const createFolder = vi.fn(async (p: string) => { tree.dirs.add(p); });
    const createBinary = vi.fn(async () => new TFile(EXPECTED_REL));
    const adapter = makeAdapter({ getBasePath: () => '/unused', exists: tree.exists });
    const app = makeApp({ getAbstractFileByPath: () => null, createFolder, createBinary }, adapter);

    await expect(writerFor(app).write('thread-1', 'msg-1', 0, 'image/png', PNG_BASE64))
      .resolves.toBe(EXPECTED_REL);
    expect(createFolder.mock.calls.map(c => c[0]))
      .toEqual(['Claude', 'Claude/attachments', 'Claude/attachments/thread-1']);
  });
});

/**
 * vault-persistence-save-race.test.ts
 *
 * Regression tests for VaultPersistence.saveThread() write-serialization and
 * self-healing.
 *
 * Before this fix, saveThread() had no per-thread lock: ~5 independent call
 * sites (status-change subscriber, message-event handler, post-summarize
 * callback, closeThread, archiveThread, plus a Promise.all on unload) all
 * called it fire-and-forget. The target filename is recomputed from
 * `thread.title` on every call, so when a thread's title changed mid-flight
 * (e.g. auto-summarization renaming it) while two saves were in flight for
 * the same thread, one call's getAbstractFileByPath -> rename/modify
 * sequence could be invalidated by another call that had already completed
 * its own rename first (a time-of-check-to-time-of-use race). Because
 * `thread.noteFile` was only updated after a successful rename, a failed
 * rename also left `noteFile` pointing at a dead path, so the next autosave
 * repeated the identical failing rename (explaining why the ENOENT errors
 * repeated rather than being one-off).
 *
 * These tests exercise the REAL VaultPersistence.saveThread()/runSaveLoop()/
 * doSaveThread() implementation (not a reimplementation), following the
 * mock-vault conventions from test/unit/vault-persistence-rawlog.test.ts and
 * the deferred-promise pattern from test/unit/save-settings-race.test.ts to
 * control async completion order explicitly.
 */

import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import { VaultPersistence } from '../../src/VaultPersistence';
import type { Thread } from '../../src/types';
import { decodeThreadRecoverySnapshot, recoverySnapshotPath } from '../../src/threadRecoverySnapshot';

/** A deferred promise whose resolution the test controls explicitly. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeApp() {
  const contents: Record<string, string> = {};
  const folders = new Set<string>();
  return {
    contents,
    folders,
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
      getFileCache: () => null,
    },
  };
}

function baseThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-uuid-1',
    title: 'Original Title',
    cwd: '/some/repo',
    messages: [],
    createdAt: new Date('2026-01-15T10:00:00Z').getTime(),
    updatedAt: new Date('2026-01-15T10:05:00Z').getTime(),
    status: 'waiting',
    ...overrides,
  };
}

describe('VaultPersistence.saveThread() — per-thread write serialization', () => {
  it('renames the recovery sidecar with its presentation note after a later title change', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, 'Claude');
    const thread = baseThread();
    const original = await vp.saveThread(thread);
    const originalSidecar = recoverySnapshotPath(original);

    thread.title = 'Later Title';
    const renamed = await vp.saveThread(thread);

    expect(renamed).not.toBe(original);
    expect(app.contents[original]).toBeUndefined();
    expect(app.contents[originalSidecar]).toBeUndefined();
    expect(app.contents[recoverySnapshotPath(renamed)]).toBeDefined();
  });

  it('concurrent saves on the same thread with a title change mid-flight do not throw and converge on exactly one file matching the final title', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, 'Claude');
    const thread = baseThread({ title: 'Original Title' });

    // Gate the first underlying create() so the first save is still "in
    // flight" when the title change and second saveThread() call happen.
    const gate = deferred<void>();
    const realCreate = app.vault.create;
    app.vault.create = vi.fn(async (p: string, content: string) => {
      await gate.promise;
      return realCreate(p, content);
    });

    const p1 = vp.saveThread(thread);
    // Title changes mid-flight, e.g. auto-summarization renaming the thread
    // while the first write (for "Original Title") is still pending.
    thread.title = 'Renamed Title';
    const p2 = vp.saveThread(thread);

    gate.resolve();

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(r2);
    expect(r1).toContain('renamed-title');
    // Exactly one presentation note and its canonical recovery sidecar exist —
    // no stale "Original Title" artifacts are left behind.
    expect(Object.keys(app.contents).sort()).toEqual([r1, recoverySnapshotPath(r1)].sort());
    expect(app.contents[r1]).toContain('# Renamed Title');
    expect(decodeThreadRecoverySnapshot(app.contents[recoverySnapshotPath(r1)])?.title).toBe('Renamed Title');
    expect(thread.noteFile).toBe(r1);
  });

  it('rapid-fire saveThread() calls on one thread coalesce into fewer underlying vault write operations than calls made', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, 'Claude');
    const thread = baseThread({ title: 'Same Title' });

    // Gate the first create() so subsequent calls stack up behind it.
    const gate = deferred<void>();
    const realCreate = app.vault.create;
    const createSpy = vi.fn(async (p: string, content: string) => {
      await gate.promise;
      return realCreate(p, content);
    });
    app.vault.create = createSpy;
    const modifySpy = vi.spyOn(app.vault, 'modify');

    const p1 = vp.saveThread(thread);
    const p2 = vp.saveThread(thread);
    const p3 = vp.saveThread(thread);

    gate.resolve();
    await Promise.all([p1, p2, p3]);

    // Each save pass writes two artifacts (presentation + recovery). Three
    // requests coalesce into at most two passes rather than six writes.
    const totalWriteOps = createSpy.mock.calls.length + modifySpy.mock.calls.length;
    expect(totalWriteOps).toBeLessThanOrEqual(4);
    expect(thread.noteFile).toBeDefined();
    expect(app.contents[thread.noteFile!]).toBeDefined();
  });

  it('self-heals when thread.noteFile points at a path that no longer exists in the vault (external deletion)', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, 'Claude');
    // Simulates a thread whose previously-saved note was deleted/moved by
    // something outside this plugin's own coalesced writes, and whose title
    // has since changed so the computed filename differs from noteFile too.
    const thread = baseThread({
      title: 'New Computed Title',
      noteFile: 'Claude/2026-01-15-stale-deleted-path.md',
    });

    const fileName = await vp.saveThread(thread);

    expect(fileName).toContain('new-computed-title');
    expect(app.contents[fileName]).toBeDefined();
    expect(thread.noteFile).toBe(fileName);
    // The dead path was never resurrected.
    expect(app.contents['Claude/2026-01-15-stale-deleted-path.md']).toBeUndefined();
  });

  it('self-heals when vault.modify() throws (ENOENT-style) even though getAbstractFileByPath returned a TFile', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, 'Claude');
    const thread = baseThread({ title: 'Modify Throws' });

    // First save creates the file normally.
    const fileName = await vp.saveThread(thread);
    expect(app.contents[fileName]).toBeDefined();

    // Simulate the file vanishing out from under a modify() call despite the
    // metadata cache having just reported it as present (a real external
    // race, not one this plugin's own coalescing can prevent).
    const modifySpy = vi.spyOn(app.vault, 'modify').mockImplementationOnce(async () => {
      throw new Error('ENOENT: file does not exist');
    });

    await expect(vp.saveThread(thread)).resolves.toBe(fileName);
    // One failed presentation modify plus one successful sidecar modify.
    expect(modifySpy).toHaveBeenCalledTimes(2);
    expect(app.contents[fileName]).toBeDefined();
    expect(thread.noteFile).toBe(fileName);
  });

  it('saves for two different thread ids do not block each other (the lock is per-key, not global)', async () => {
    const app = makeApp();
    const vp = new VaultPersistence(app as any, 'Claude');

    const threadA = baseThread({ id: 'thread-a', title: 'Blocked Thread' });
    const threadB = baseThread({ id: 'thread-b', title: 'Free Thread' });

    // Gate create() only for thread A's file, leaving thread B's write free
    // to complete immediately.
    const gateA = deferred<void>();
    const realCreate = app.vault.create;
    app.vault.create = vi.fn(async (p: string, content: string) => {
      if (p.includes('blocked-thread')) {
        await gateA.promise;
      }
      return realCreate(p, content);
    });

    let aDone = false;
    let bDone = false;
    const pA = vp.saveThread(threadA).then((r) => { aDone = true; return r; });
    const pB = vp.saveThread(threadB).then((r) => { bDone = true; return r; });

    // Thread B's save must complete without waiting on thread A's gate.
    await pB;
    expect(bDone).toBe(true);
    expect(aDone).toBe(false);

    gateA.resolve();
    await pA;
    expect(aDone).toBe(true);
  });
});

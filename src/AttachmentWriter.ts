import { App, FileSystemAdapter, TFile, base64ToArrayBuffer } from 'obsidian';
import { buildAttachmentPath } from './imageExternalization';
import { debugLog } from './logger';

/**
 * Writes message images out to real vault attachment files so they stop bloating
 * data.json (ADR-0003, PR 1). Files live at
 * `<vaultFolder>/attachments/<threadId>/<messageId>-<index>.<ext>`, mirroring
 * RawLogWriter's per-thread `logs/<threadId>.jsonl` convention.
 *
 * Hosts disagree about which write API exists, so every write walks a
 * three-rung fallback ladder (see `write`). The plugin runs inside both
 * Obsidian and Geode, and Geode's Obsidian shim implements only a subset of
 * `FileSystemAdapter`: `getBasePath`, `getName`, `getResourcePath` and
 * `exists`. Assuming the full adapter is what broke this class.
 *
 * The exact failure, confirmed by running this class against a surface
 * reconstructed from Geode's own source rather than inferred: the
 * `instanceof FileSystemAdapter` guard passes under Geode (its shim returns a
 * real instance, deliberately, so plugin desktop guards resolve). `ensureDir`
 * then called `adapter.mkdir(...)`, which is `undefined` there - but that
 * TypeError was already swallowed by ensureDir's own catch, so it was NOT
 * what killed the write. The throw that actually escaped `write()` came one
 * step later, from `app.vault.createBinary` being undefined too. Every
 * attachment silently stayed inline as base64 in data.json.
 *
 * Both are worth stating because fixing only the `mkdir` call would have left
 * the bug fully intact. Note also that Geode DOES implement
 * `vault.createFolder`, so under Geode `ensureDir` now succeeds via that
 * branch; it is the write itself that still falls through to rung 3.
 *
 * Desktop-only: every method is a no-op off a FileSystemAdapter (mobile is
 * relay-fed and cannot resolve a desktop attachment path). Never throws into the
 * session hot path. A write failure is logged and swallowed, leaving base64 in
 * place, exactly the graceful-degradation posture RawLogWriter.enqueue takes.
 *
 * App and vault folder are read lazily through getters because ThreadManager
 * populates them after construction (same wiring RawLogWriter uses for its
 * vault root/folder).
 */

/**
 * The binary-write surface a host may expose on `window.geode`.
 *
 * Duck-typed, never version-checked: Geode reports no version to plugins, so
 * "is this a function?" is the only safe test. Same posture as
 * `WakeLockService.detectNativeBridge`. Geode does not implement this yet -
 * this rung is forward-looking and simply never fires until it does.
 */
export interface HostBinaryWriteBridge {
  writeBinary(path: string, base64: string): Promise<unknown>;
}

interface HostWindowLike {
  geode?: Partial<HostBinaryWriteBridge>;
}

/**
 * The vault methods this writer probes for. Every member is optional because
 * a host shim may implement only some of them; the real Obsidian type declares
 * them all as required, which is exactly the assumption that caused the bug.
 */
interface ProbedVault {
  getAbstractFileByPath(path: string): unknown;
  createBinary?(path: string, data: ArrayBuffer): Promise<TFile>;
  modifyBinary?(file: TFile, data: ArrayBuffer): Promise<void>;
  createFolder?(path: string): Promise<unknown>;
}

/** The adapter methods this writer probes for. Optional for the same reason. */
interface ProbedAdapter {
  getBasePath?(): string;
  exists?(path: string): Promise<boolean> | boolean;
  writeBinary?(path: string, data: ArrayBuffer): Promise<void>;
  mkdir?(path: string): Promise<void>;
}

function defaultHostWindow(): HostWindowLike {
  return (globalThis as unknown as { window?: HostWindowLike }).window ?? {};
}

export class AttachmentWriter {
  /** Directories already ensured this session, to skip redundant exists/mkdir. */
  private ensuredDirs = new Set<string>();

  constructor(
    private getApp: () => App | null,
    private getVaultFolder: () => string,
    /** Injectable for tests; defaults to the real host window. */
    private getHostWindow: () => HostWindowLike = defaultHostWindow,
  ) {}

  /** True only on desktop, where a real filesystem vault exists. */
  isDesktop(): boolean {
    const app = this.getApp();
    return !!app && app.vault.adapter instanceof FileSystemAdapter;
  }

  /**
   * Write one image to its attachment file and return the vault-relative path,
   * or null if the write was skipped (mobile) or every rung failed. Idempotent:
   * an existing file at the target path is overwritten rather than duplicated,
   * so a backfill re-run is harmless.
   *
   * Three rungs, tried in order, each isolated so a missing API on one host
   * degrades to the next instead of aborting the whole write:
   *
   *   1. `window.geode.writeBinary`: preferred, because only the host can
   *      refresh its own vault index, so the file is immediately resolvable.
   *   2. The Obsidian vault API (`modifyBinary` / `adapter.writeBinary` /
   *      `createBinary`): registers with the metadata cache.
   *   3. Node `fs` straight to disk: see `writeThroughNodeFs` for the caveat.
   */
  async write(
    threadId: string,
    messageId: string,
    index: number,
    mediaType: string,
    base64: string,
  ): Promise<string | null> {
    const app = this.getApp();
    if (!app || !(app.vault.adapter instanceof FileSystemAdapter)) return null;

    const rel = buildAttachmentPath(this.getVaultFolder(), threadId, messageId, index, mediaType);

    // Rung 1: native host bridge.
    const bridge = this.hostBinaryWriter();
    if (bridge) {
      try {
        await bridge.writeBinary(rel, base64);
        return rel;
      } catch (err) {
        debugLog('[ClaudeThreads] attachment write via host bridge failed:', rel, String(err));
      }
    }

    // Rung 2: Obsidian vault API.
    try {
      const buffer = base64ToArrayBuffer(base64);
      await this.ensureDir(app, rel.slice(0, rel.lastIndexOf('/')));
      await this.writeThroughVault(app, rel, buffer);
      return rel;
    } catch (err) {
      debugLog('[ClaudeThreads] attachment write via vault API failed:', rel, String(err));
    }

    // Rung 3: Node fs.
    try {
      this.writeThroughNodeFs(app.vault.adapter, rel, base64);
      return rel;
    } catch (err) {
      debugLog('[ClaudeThreads] attachment write via fs failed:', rel, String(err));
    }

    return null;
  }

  /**
   * Remove a thread's entire attachment directory. Used on a hard-delete of a
   * thread that has no markdown note (see ThreadManager.deleteThread). No-op off
   * desktop, if the directory doesn't exist, or if the host exposes no way to
   * remove it (leaving orphaned files is a far cheaper failure than throwing
   * out of a delete).
   */
  async removeThreadDir(threadId: string): Promise<void> {
    const app = this.getApp();
    if (!app || !(app.vault.adapter instanceof FileSystemAdapter)) return;
    const folder = this.getVaultFolder() || 'Claude';
    const dir = `${folder}/attachments/${threadId}`;
    try {
      if (await app.vault.adapter.exists(dir)) {
        await app.vault.adapter.rmdir(dir, true);
      }
      this.ensuredDirs.delete(dir);
    } catch (err) {
      debugLog('[ClaudeThreads] attachment dir remove failed:', dir, String(err));
    }
  }

  /**
   * Rung 1 detection. Returns the bridge only when `writeBinary` is actually a
   * function, so a host that exposes `window.geode` without it falls straight
   * through to rung 2 rather than throwing.
   */
  private hostBinaryWriter(): HostBinaryWriteBridge | null {
    let geode: Partial<HostBinaryWriteBridge> | undefined;
    try {
      geode = this.getHostWindow()?.geode;
    } catch {
      return null;
    }
    if (typeof geode?.writeBinary !== 'function') return null;
    return geode as HostBinaryWriteBridge;
  }

  /**
   * Rung 2 write. Throws (rather than returning false) when the host is missing
   * the method this branch needs, so `write` falls through to rung 3 with the
   * reason logged.
   */
  private async writeThroughVault(app: App, rel: string, buffer: ArrayBuffer): Promise<void> {
    const vault = app.vault as unknown as ProbedVault;
    const adapter = app.vault.adapter as unknown as ProbedAdapter;

    const existing = vault.getAbstractFileByPath(rel);
    if (existing instanceof TFile) {
      if (typeof vault.modifyBinary !== 'function') throw new Error('vault.modifyBinary unavailable');
      await vault.modifyBinary(existing, buffer);
      return;
    }

    // On disk but not yet in the metadata cache (e.g. created a prior session):
    // overwrite via the adapter rather than risk a createBinary "already
    // exists" throw.
    if (typeof adapter.exists === 'function' && (await adapter.exists(rel))) {
      if (typeof adapter.writeBinary !== 'function') throw new Error('adapter.writeBinary unavailable');
      await adapter.writeBinary(rel, buffer);
      return;
    }

    if (typeof vault.createBinary !== 'function') throw new Error('vault.createBinary unavailable');
    await vault.createBinary(rel, buffer);
  }

  /**
   * Rung 3: write the bytes straight to disk under the vault root.
   *
   * Known caveat, accepted deliberately: a file written this way is invisible
   * to the host's metadata cache until it rescans, so an `![[attachments/...]]`
   * embed may not resolve immediately (it resolves after the next vault scan or
   * restart). That is still strictly better than the alternative, which is the
   * silent no-op this ladder replaces, one that left multi-megabyte base64
   * inline in data.json forever, the exact bloat ADR-0003 was written to
   * eliminate. Rung 1 avoids the caveat entirely once Geode ships
   * `window.geode.writeBinary`.
   *
   * `fs`/`path` are required lazily, never at module scope: ThreadManager
   * imports this module eagerly and Obsidian Mobile's require() interceptor
   * returns null for Node built-ins (see test/unit/bundle-safety.test.ts).
   */
  private writeThroughNodeFs(adapter: FileSystemAdapter, rel: string, base64: string): void {
    const probed = adapter as unknown as ProbedAdapter;
    if (typeof probed.getBasePath !== 'function') throw new Error('adapter.getBasePath unavailable');
    const basePath = probed.getBasePath();
    if (!basePath) throw new Error('adapter.getBasePath returned no vault root');

    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const abs = path.join(basePath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(base64, 'base64'));
  }

  /**
   * Ensure every ancestor of `dir` exists, using whichever directory-create API
   * the host actually implements. Walks segment-by-segment with an exists-check
   * so it works whether or not that API is recursive, and tolerates a concurrent
   * create (two images for the same message race here).
   *
   * Throws if the directory still doesn't exist afterwards, so `write` drops to
   * rung 3 (which does its own recursive mkdir) instead of attempting a vault
   * write that is guaranteed to fail. Caches the full dir only on success, so a
   * failed attempt isn't remembered as done.
   */
  private async ensureDir(app: App, dir: string): Promise<void> {
    if (!dir || this.ensuredDirs.has(dir)) return;
    const vault = app.vault as unknown as ProbedVault;
    const adapter = app.vault.adapter as unknown as ProbedAdapter;

    const mkdir: ((p: string) => Promise<unknown>) | null =
      typeof adapter.mkdir === 'function'
        ? (p) => Promise.resolve(adapter.mkdir!(p))
        : typeof vault.createFolder === 'function'
          ? (p) => Promise.resolve(vault.createFolder!(p))
          : null;
    if (!mkdir) throw new Error('host exposes no mkdir/createFolder');

    const exists = typeof adapter.exists === 'function'
      ? (p: string) => Promise.resolve(adapter.exists!(p))
      : (p: string) => Promise.resolve(vault.getAbstractFileByPath(p) != null);

    const segments = dir.split('/');
    let cur = '';
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg;
      // eslint-disable-next-line no-await-in-loop
      if (await exists(cur)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await mkdir(cur);
      } catch {
        // A concurrent write may have created it between the check and here.
      }
    }

    if (!(await exists(dir))) throw new Error(`attachment directory not created: ${dir}`);
    this.ensuredDirs.add(dir);
  }
}

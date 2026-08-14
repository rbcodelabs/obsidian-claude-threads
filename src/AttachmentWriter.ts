import { App, FileSystemAdapter, TFile, base64ToArrayBuffer } from 'obsidian';
import { buildAttachmentPath } from './imageExternalization';
import { debugLog } from './logger';

/**
 * Writes message images out to real vault attachment files so they stop bloating
 * data.json (ADR-0003, PR 1). Files live at
 * `<vaultFolder>/attachments/<threadId>/<messageId>-<index>.<ext>`, mirroring
 * RawLogWriter's per-thread `logs/<threadId>.jsonl` convention.
 *
 * Uses the vault API (createBinary/modifyBinary) rather than the raw adapter so
 * the files register with Obsidian's metadata cache, so a later PR can embed
 * them in a note via `![[attachment]]` and have the link resolve.
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
export class AttachmentWriter {
  /** Directories already ensured this session, to skip redundant exists/mkdir. */
  private ensuredDirs = new Set<string>();

  constructor(
    private getApp: () => App | null,
    private getVaultFolder: () => string,
  ) {}

  /** True only on desktop, where a real filesystem vault exists. */
  isDesktop(): boolean {
    const app = this.getApp();
    return !!app && app.vault.adapter instanceof FileSystemAdapter;
  }

  /**
   * Write one image to its attachment file and return the vault-relative path,
   * or null if the write was skipped (mobile) or failed. Idempotent: an existing
   * file at the target path is overwritten rather than duplicated, so a backfill
   * re-run is harmless.
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
    try {
      const buffer = base64ToArrayBuffer(base64);
      const dir = rel.slice(0, rel.lastIndexOf('/'));
      await this.ensureDir(app, dir);

      const existing = app.vault.getAbstractFileByPath(rel);
      if (existing instanceof TFile) {
        await app.vault.modifyBinary(existing, buffer);
      } else if (await app.vault.adapter.exists(rel)) {
        // On disk but not yet in the metadata cache (e.g. created a prior
        // session): overwrite via the adapter rather than risk a createBinary
        // "already exists" throw.
        await app.vault.adapter.writeBinary(rel, buffer);
      } else {
        await app.vault.createBinary(rel, buffer);
      }
      return rel;
    } catch (err) {
      debugLog('[ClaudeThreads] attachment write failed:', rel, String(err));
      return null;
    }
  }

  /**
   * Remove a thread's entire attachment directory. Used on a hard-delete of a
   * thread that has no markdown note (see ThreadManager.deleteThread). No-op off
   * desktop or if the directory doesn't exist.
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
   * Ensure every ancestor of `dir` exists. Walks segment-by-segment with an
   * exists-check so it works whether or not the adapter's mkdir is recursive,
   * and tolerates a concurrent create (two images for the same message race
   * here). Caches the full dir once ensured.
   */
  private async ensureDir(app: App, dir: string): Promise<void> {
    if (!dir || this.ensuredDirs.has(dir)) return;
    const adapter = app.vault.adapter;
    const segments = dir.split('/');
    let cur = '';
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg;
      // eslint-disable-next-line no-await-in-loop
      if (!(await adapter.exists(cur))) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await adapter.mkdir(cur);
        } catch {
          // A concurrent write may have created it between the check and here.
        }
      }
    }
    this.ensuredDirs.add(dir);
  }
}

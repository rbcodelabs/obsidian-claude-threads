import { debugLog } from './logger';

/**
 * One line in a raw JSONL conversation log. Wraps the verbatim SDK event with a
 * uniform envelope so downstream agents can parse every line the same way:
 *
 *   { ts, threadId, sessionId, type, event }
 *
 * `type` mirrors the SDK message type (assistant, user, result, system,
 * rate_limit_event, tool_use_summary) or a synthetic marker kind
 * (session_start). `event` is the raw payload, untouched.
 */
export interface RawLogEnvelope {
  /** ISO-8601 timestamp when the line was written. */
  ts: string;
  threadId: string;
  sessionId?: string;
  type: string;
  event: unknown;
}

/**
 * Append-only writer for per-thread raw JSONL conversation logs.
 *
 * Logs live at `<vaultRoot>/<vaultFolder>/logs/<thread_id>.jsonl`. Keying by the
 * stable thread UUID (not the title) means the log never orphans when a thread
 * is renamed and its markdown note moves.
 *
 * Writes are append-only and serialized per file via a promise chain so events
 * land in arrival order without blocking the Obsidian UI thread. Vault root and
 * folder are read lazily through getters because ThreadManager populates
 * `vaultRoot` after construction.
 */
export class RawLogWriter {
  /** Tail of the in-flight append chain, keyed by absolute file path. */
  private writeTails = new Map<string, Promise<void>>();
  /** Directories already created this session, to skip redundant mkdir calls. */
  private ensuredDirs = new Set<string>();

  constructor(
    private getVaultRoot: () => string,
    private getVaultFolder: () => string,
  ) {}

  /**
   * True for events worth persisting. Partial streaming token deltas
   * (`stream_event`) are skipped — they are reconstructed verbatim in the
   * final `assistant` message, so logging them would bloat the file ~10-50x
   * with no added signal.
   */
  static shouldLog(type: string | undefined): boolean {
    return type !== 'stream_event';
  }

  /** Vault-relative path for a thread's log (used for frontmatter linking). */
  vaultRelativePath(threadId: string): string {
    const folder = this.getVaultFolder() || 'Claude';
    return `${folder}/logs/${threadId}.jsonl`;
  }

  /** Absolute filesystem path, or null if the vault root isn't known yet. */
  private absolutePath(threadId: string): string | null {
    const root = this.getVaultRoot();
    if (!root) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    return path.join(root, this.getVaultFolder() || 'Claude', 'logs', `${threadId}.jsonl`);
  }

  /**
   * Append one event to a thread's log. No-op if the vault root is unknown.
   * Never throws — append failures are logged and swallowed so a disk hiccup
   * can't break an active session.
   */
  append(threadId: string, sessionId: string | undefined, type: string, event: unknown): void {
    const abs = this.absolutePath(threadId);
    if (!abs) return;

    const envelope: RawLogEnvelope = {
      ts: new Date().toISOString(),
      threadId,
      sessionId,
      type,
      event,
    };
    let line: string;
    try {
      line = JSON.stringify(envelope) + '\n';
    } catch {
      // Defensive: a circular or non-serializable payload shouldn't lose the record.
      line = JSON.stringify({ ts: envelope.ts, threadId, sessionId, type, event: '[unserializable]' }) + '\n';
    }
    this.enqueue(abs, line);
  }

  /**
   * Read and parse a thread's log. Entries are filtered by `type` (if given)
   * and then tailed to the most recent `limit` (default 100, `0` = all).
   * Returns null when the vault root is unknown or no log file exists yet.
   * Malformed lines are skipped rather than throwing, so a single bad record
   * never makes the whole log unreadable.
   */
  async read(
    threadId: string,
    opts?: { limit?: number; type?: string },
  ): Promise<{ path: string; total: number; returned: number; entries: RawLogEnvelope[] } | null> {
    const abs = this.absolutePath(threadId);
    if (!abs) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    let content: string;
    try {
      content = await fs.promises.readFile(abs, 'utf8');
    } catch {
      return null; // no log file written yet
    }
    const parsed: RawLogEnvelope[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        parsed.push(JSON.parse(line) as RawLogEnvelope);
      } catch {
        // skip a malformed line rather than failing the whole read
      }
    }
    const filtered = opts?.type ? parsed.filter((e) => e.type === opts.type) : parsed;
    const limit = opts?.limit ?? 100;
    const entries = limit > 0 ? filtered.slice(-limit) : filtered;
    return { path: abs, total: filtered.length, returned: entries.length, entries };
  }

  private enqueue(abs: string, line: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const dir = path.dirname(abs);

    const prev = this.writeTails.get(abs) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // a prior failure must not stall the chain
      .then(async () => {
        if (!this.ensuredDirs.has(dir)) {
          await fs.promises.mkdir(dir, { recursive: true });
          this.ensuredDirs.add(dir);
        }
        await fs.promises.appendFile(abs, line, 'utf8');
      })
      .catch((err) => {
        debugLog('[ClaudeThreads] raw log append failed:', String(err));
      });
    this.writeTails.set(abs, next);
  }
}

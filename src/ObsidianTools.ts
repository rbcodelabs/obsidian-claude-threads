import { z } from 'zod';
// Import from the browser entry point to avoid Node.js-only APIs (e.g. setTimeout().unref())
// that crash in Electron's renderer context.
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk/browser';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { App, TFile } from 'obsidian';
import fs from 'fs';
import os from 'os';
import { tokenizeQuery, findBestExcerpt } from './searchUtils';
import { execFileSync } from 'child_process';

// Reusable Zod schemas for tools that take a file path
const pathSchema = { path: z.string().describe('Vault-relative path of the file') };

const navigateToFileSchema = {
  path: z.string().describe('Vault-relative path of the file to open'),
  newLeaf: z.boolean().optional().describe('If true, open in a new tab'),
};

const searchVaultSchema = {
  query: z.string().describe('Search string to match against file paths and content'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of results to return (default 20)'),
};

const insertAtCursorSchema = {
  text: z.string().describe('Text to insert at the current cursor position in the active editor'),
};

const listCommandsSchema = {
  query: z
    .string()
    .optional()
    .describe(
      'Optional filter — returns only commands whose name or ID contains this string (case-insensitive)',
    ),
};

const executeCommandSchema = {
  commandId: z
    .string()
    .describe(
      'The command ID to execute (e.g. "editor:toggle-bold", "obsidian-git:push"). Use obsidian_list_commands to discover available IDs.',
    ),
};

// ── Thread-state snapshot types ───────────────────────────────────────────────
// Plain data types used by the thread-coordination tools below.
// These are intentionally decoupled from ThreadManager internals so this file
// stays self-contained and can be used in isolation (e.g. tests).

export interface ThreadSnapshot {
  id: string;
  title: string;
  /** ThreadStatus value or 'waiting' if unset */
  status: string;
  /** True while Claude is actively processing a request on this thread */
  isRunning: boolean;
  projectId?: string;
  cwd?: string;
  updatedAt: number;
  /** Number of non-compact messages */
  messageCount: number;
}

export interface ThreadMessageSnapshot {
  id: string;
  /** 'user' | 'assistant' */
  role: string;
  content: string;
  timestamp: number;
}

export interface ThreadDetail extends ThreadSnapshot {
  messages: ThreadMessageSnapshot[];
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  description?: string;
  vaultFolder?: string;
}

// ── Vault Bridge schema ───────────────────────────────────────────────────────

const addVaultBridgeSchema = {
  name: z.string().describe('Human-readable label for the bridge (e.g. "Agentic PM Playbook")'),
  repoPath: z.string().describe('Absolute local path to the git repository root'),
  vaultPath: z
    .string()
    .describe('Vault-relative destination path (e.g. "Playbooks/Agentic PM Playbook")'),
  sourcePath: z
    .string()
    .optional()
    .describe('Subfolder within the repo to copy. Omit to sync the whole repo.'),
  branch: z.string().optional().describe('Git branch to pull from. Defaults to "main".'),
  autoSync: z
    .boolean()
    .optional()
    .describe('Pull this bridge when Obsidian opens. Defaults to true.'),
  syncNow: z
    .boolean()
    .optional()
    .describe('Immediately sync after adding. Defaults to false.'),
};

// ── Factory ──────────────────────────────────────────────────────────────────

export interface ObsidianMcpServerOptions {
  /** Called when the agent requests a working-directory change. Receives the resolved absolute path. */
  onSetCwd?: (path: string) => void;
  /** Called when the agent schedules a wakeup. delayMs is the delay in milliseconds. */
  onScheduleWakeup?: (delayMs: number, prompt: string, reason: string) => void;
  /**
   * Called when the agent requests a fork of the current conversation.
   * focusArea is an optional description of what the new thread should focus on.
   * Resolves with the new thread title on success, or throws on failure.
   */
  onForkRequested?: (focusArea: string) => Promise<{ threadTitle: string }>;
  /**
   * Initial effective cwd for this session. Pre-seeds the in-session cwd tracker so
   * enter_worktree knows which repo to operate on from the first turn.
   */
  initialCwd?: string;
  /** ID of the current thread. Used by obsidian_get_current_thread. */
  threadId?: string;
  /** Returns full detail (metadata + messages) for a thread by ID. */
  getThreadDetail?: (id: string) => ThreadDetail | undefined;
  /** Returns metadata snapshots for all threads. */
  getAllThreads?: () => ThreadSnapshot[];
  /** Returns all projects. */
  getAllProjects?: () => ProjectSnapshot[];
  /** Returns true if the given thread is currently processing a request. */
  isThreadRunning?: (id: string) => boolean;
  /** Sends a message to a thread, triggering Claude to process it. */
  sendMessageToThread?: (id: string, message: string) => Promise<void>;
}

/**
 * Creates an MCP server config with Obsidian-specific tools bound to the given App instance.
 * Pass the result as `{ obsidian: createObsidianMcpServer(this.app) }` in the `mcpServers` option.
 */
export function createObsidianMcpServer(app: App, options: ObsidianMcpServerOptions = {}): McpSdkServerConfigWithInstance {
  // ── In-session cwd tracking ────────────────────────────────────────────────
  // Unlike cwdAtStart in ThreadManager (which is frozen in the subprocess),
  // effectiveCwd is updated immediately by set_working_directory so worktree
  // tools always operate on the right repo within the same turn.
  let effectiveCwd = options.initialCwd ?? '';

  // worktreePath → originalGitRoot, for tracking active worktrees this session.
  const activeWorktrees = new Map<string, string>();

  const boundGetOpenTabs = tool(
    'obsidian_get_open_tabs',
    'Returns all open tabs in the Obsidian workspace with their path, title, type, and whether they are the active tab.',
    {},
    async (_args, _extra) => {
      try {
        const activeFile = app.workspace.getActiveFile();
        const tabs: Array<{ path: string; title: string; type: string; isActive: boolean }> = [];

        app.workspace.iterateAllLeaves((leaf) => {
          const view = leaf.view as unknown as Record<string, unknown>;
          const file = view?.file;
          if (file instanceof TFile) {
            tabs.push({
              path: file.path,
              title: file.basename,
              type: leaf.view.getViewType(),
              isActive: file.path === activeFile?.path,
            });
          }
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(tabs, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundGetActiveFile = tool(
    'obsidian_get_active_file',
    'Returns metadata for the currently active file in Obsidian (path, basename, extension, mtime, ctime, size), or null if nothing is open.',
    {},
    async (_args, _extra) => {
      try {
        const file = app.workspace.getActiveFile();
        if (!file) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(null) }] };
        }
        const result = {
          path: file.path,
          basename: file.basename,
          extension: file.extension,
          mtime: file.stat.mtime,
          ctime: file.stat.ctime,
          size: file.stat.size,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundNavigateToFile = tool(
    'obsidian_navigate_to_file',
    'Opens a file in Obsidian by its vault-relative path. Optionally opens it in a new tab.',
    navigateToFileSchema,
    async (args, _extra) => {
      try {
        const abstract = app.vault.getAbstractFileByPath(args.path);
        if (!(abstract instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${args.path}` }],
            isError: true,
          };
        }
        const leaf = app.workspace.getLeaf(args.newLeaf ? 'tab' : false);
        await leaf.openFile(abstract);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: msg }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  const boundSearchVault = tool(
    'obsidian_search_vault',
    'Searches markdown files in the vault by filename and content. Tokenizes multi-word queries so each term is matched independently — partial matches across scattered words are found. Returns results ranked by relevance score (filename hits weighted 10x) with a ~300-char excerpt from the densest matching region.',
    searchVaultSchema,
    async (args, _extra) => {
      try {
        const { query, limit = 20 } = args;

        const terms = tokenizeQuery(query);
        if (terms.length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify([]) }] };
        }

        const files = app.vault.getMarkdownFiles();
        const scored: Array<{
          path: string;
          matchType: 'filename' | 'content';
          score: number;
          excerpt?: string;
        }> = [];

        for (const file of files) {
          const pathLower = file.path.toLowerCase();

          // Filename score: 10 points per matching term (weighted above content hits)
          let filenameScore = 0;
          for (const term of terms) {
            if (pathLower.includes(term)) filenameScore += 10;
          }

          // Content score: count total occurrences of each term across the file
          let contentScore = 0;
          let excerpt: string | undefined;
          try {
            const content = await app.vault.cachedRead(file);
            const contentLower = content.toLowerCase();
            for (const term of terms) {
              let idx = contentLower.indexOf(term);
              while (idx !== -1) {
                contentScore++;
                idx = contentLower.indexOf(term, idx + 1);
              }
            }
            if (contentScore > 0) {
              excerpt = findBestExcerpt(content, contentLower, terms);
            }
          } catch {
            // Skip unreadable files
          }

          const totalScore = filenameScore + contentScore;
          if (totalScore > 0) {
            scored.push({
              path: file.path,
              matchType: filenameScore > 0 ? 'filename' : 'content',
              score: totalScore,
              excerpt,
            });
          }
        }

        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, limit).map(({ path, matchType, score, excerpt }) => ({
          path,
          matchType,
          score,
          ...(excerpt ? { excerpt } : {}),
        }));

        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundGetBacklinks = tool(
    'obsidian_get_backlinks',
    'Returns all notes that link to the specified file (backlinks), with the source path and original link text.',
    pathSchema,
    async (args, _extra) => {
      try {
        const abstract = app.vault.getAbstractFileByPath(args.path);
        if (!(abstract instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${args.path}` }],
            isError: true,
          };
        }

        type BacklinksCache = {
          getBacklinksForFile: (file: TFile) => {
            data: {
              forEach: (
                cb: (refs: Array<{ original: string }>, sourcePath: string) => void,
              ) => void;
            };
          };
        };
        const backlinksObj = (app.metadataCache as unknown as BacklinksCache).getBacklinksForFile(abstract);
        const results: Array<{ sourcePath: string; linkTexts: string[] }> = [];

        backlinksObj.data.forEach((refs, sourcePath) => {
          results.push({ sourcePath, linkTexts: refs.map((r) => r.original) });
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundGetOutgoingLinks = tool(
    'obsidian_get_outgoing_links',
    'Returns all wikilinks and markdown links that a note makes to other files, with display text and resolved vault paths.',
    pathSchema,
    async (args, _extra) => {
      try {
        const abstract = app.vault.getAbstractFileByPath(args.path);
        if (!(abstract instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${args.path}` }],
            isError: true,
          };
        }

        const cache = app.metadataCache.getFileCache(abstract);
        const links = (cache?.links ?? []).map((linkRef) => ({
          link: linkRef.link,
          displayText: linkRef.displayText ?? linkRef.link,
          resolvedPath:
            app.metadataCache.getFirstLinkpathDest(linkRef.link, args.path)?.path ?? null,
        }));

        return { content: [{ type: 'text' as const, text: JSON.stringify(links, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundInsertAtCursor = tool(
    'obsidian_insert_at_cursor',
    'Inserts text at the cursor position in the currently active Obsidian editor, replacing any current selection.',
    insertAtCursorSchema,
    async (args, _extra) => {
      try {
        const editor = app.workspace.activeEditor?.editor;
        if (!editor) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ success: false, error: 'No active editor' }, null, 2),
              },
            ],
            isError: true,
          };
        }
        editor.replaceSelection(args.text);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true }, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: msg }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  const boundGetNoteMetadata = tool(
    'obsidian_get_note_metadata',
    'Returns the full metadata cache entry for a note: frontmatter, tags, wikilinks, and headings.',
    pathSchema,
    async (args, _extra) => {
      try {
        const abstract = app.vault.getAbstractFileByPath(args.path);
        if (!(abstract instanceof TFile)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File not found: ${args.path}` }],
            isError: true,
          };
        }

        const cache = app.metadataCache.getFileCache(abstract);
        const links = (cache?.links ?? []).map((linkRef) => ({
          link: linkRef.link,
          displayText: linkRef.displayText ?? linkRef.link,
          resolvedPath:
            app.metadataCache.getFirstLinkpathDest(linkRef.link, args.path)?.path ?? null,
        }));

        const result = {
          path: args.path,
          frontmatter: cache?.frontmatter ?? null,
          tags: (cache?.tags ?? []).map((t) => t.tag),
          links,
          headings: (cache?.headings ?? []).map((h) => ({ level: h.level, heading: h.heading })),
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundScheduleWakeup = tool(
    'ScheduleWakeup',
    [
      'Schedules a wakeup to resume this conversation after a delay.',
      'When the timer fires, the prompt is injected as a new user message into the same thread, waking the conversation back up.',
      'Use for polling CI status, waiting for deploys to finish, or self-pacing loop work.',
      'The reason field is a human-readable label shown in logs and UI.',
    ].join(' '),
    {
      delaySeconds: z.number().describe('Seconds to wait before waking up'),
      prompt: z.string().describe('The message to inject as a user message when the timer fires'),
      reason: z.string().describe('Human-readable reason for the wakeup (for display/logging)'),
    },
    async (args, _extra) => {
      try {
        options.onScheduleWakeup?.(args.delaySeconds * 1000, args.prompt, args.reason);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Wakeup scheduled in ${args.delaySeconds}s — ${args.reason}`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundSetWorkingDirectory = tool(
    'set_working_directory',
    [
      'Changes the working directory for this Claude session. Use this when you need to switch context to a different repository or project folder. Accepts an absolute path; ~ is expanded to the home directory.',
      'The change takes effect on the next turn — the current query continues in the original directory. Returns the resolved absolute path on success.',
    ].join(' '),
    {
      path: z.string().describe('Absolute filesystem path to set as the new working directory (~ is expanded)'),
    },
    async (args, _extra) => {
      try {
        const resolved = args.path.replace(/^~(?=\/|$)/, os.homedir());

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Path does not exist: ${resolved}` }) }],
            isError: true,
          };
        }

        if (!fs.statSync(resolved).isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Not a directory: ${resolved}` }) }],
            isError: true,
          };
        }

        // Update both the persisted cwd (for next session) and the in-session
        // effective cwd (used immediately by obsidian_enter_worktree).
        effectiveCwd = resolved;
        options.onSetCwd?.(resolved);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, cwd: resolved }) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  // ── Worktree tools ──────────────────────────────────────────────────────────
  // These replace the built-in EnterWorktree / ExitWorktree SDK tools for
  // sessions running inside the Obsidian plugin.  The SDK's built-in tools use
  // the frozen OS-level subprocess cwd (set at session start), so they always
  // operate on whatever repo was active when the thread was created — usually
  // the vault root.  These MCP versions read effectiveCwd instead, which is
  // updated immediately whenever set_working_directory is called.

  const boundEnterWorktree = tool(
    'enter_worktree',
    [
      'Creates a new git worktree for the repo at the current effective working directory and switches this session to use it.',
      'The worktree is an isolated copy of the repo on a new branch — changes there do not affect the main checkout.',
      'After this call the session cwd is updated to the worktree path (takes effect next turn).',
      'Use exit_worktree to remove the worktree and restore the original repo path.',
      'Use this instead of the built-in EnterWorktree tool when running inside the Obsidian plugin.',
    ].join(' '),
    {
      branch: z.string().optional().describe(
        'Branch name to create in the worktree. Auto-generated as claude/<timestamp> if omitted.',
      ),
      baseBranch: z.string().optional().describe(
        'Base branch or commit to start from. Defaults to HEAD.',
      ),
      repoPath: z.string().optional().describe(
        'Override which git repo to use. Defaults to the current effective working directory.',
      ),
    },
    async (args, _extra) => {
      try {
        const path = require('path') as typeof import('path');

        const repoPath = args.repoPath ?? effectiveCwd;
        if (!repoPath) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No working directory set. Call set_working_directory first.' }) }],
            isError: true,
          };
        }

        // Resolve the git root (handles cases where repoPath is a subdirectory)
        let gitRoot: string;
        try {
          gitRoot = execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
        } catch {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Not a git repository: ${repoPath}` }) }],
            isError: true,
          };
        }

        // Generate a unique worktree directory under os.tmpdir()
        const worktreeId = crypto.randomUUID().slice(0, 8);
        const worktreePath = path.join(os.tmpdir(), 'claude-worktrees', worktreeId);
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

        const branchName = args.branch ?? `claude/${Date.now()}`;

        // git worktree add <path> -b <branch> [<base>]
        const gitArgs = ['worktree', 'add', worktreePath, '-b', branchName];
        if (args.baseBranch) gitArgs.push(args.baseBranch);

        try {
          execFileSync('git', gitArgs, { cwd: gitRoot, encoding: 'utf8' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `git worktree add failed: ${msg}` }) }],
            isError: true,
          };
        }

        activeWorktrees.set(worktreePath, gitRoot);
        effectiveCwd = worktreePath;
        options.onSetCwd?.(worktreePath);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              worktreePath,
              branch: branchName,
              gitRoot,
              message: 'Worktree created. Send any follow-up message to continue in the worktree.',
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  const boundExitWorktree = tool(
    'exit_worktree',
    [
      'Removes a git worktree created by enter_worktree and restores the session working directory to the original repo root.',
      'If no path is provided, removes the current effective working directory if it is a tracked worktree.',
      'Use this instead of the built-in ExitWorktree tool when running inside the Obsidian plugin.',
    ].join(' '),
    {
      worktreePath: z.string().optional().describe(
        'Absolute path of the worktree to remove. Defaults to the current effective working directory.',
      ),
      force: z.boolean().optional().describe(
        'Force removal even if the worktree has uncommitted changes (default: false).',
      ),
    },
    async (args, _extra) => {
      try {
        const targetPath = args.worktreePath ?? effectiveCwd;
        const originalRepo = activeWorktrees.get(targetPath);

        if (!originalRepo) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `No tracked worktree at: ${targetPath}. Use \`git worktree remove\` manually if needed.`,
              }),
            }],
            isError: true,
          };
        }

        const removeArgs = ['worktree', 'remove', targetPath];
        if (args.force) removeArgs.push('--force');

        try {
          execFileSync('git', removeArgs, { cwd: originalRepo, encoding: 'utf8' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `git worktree remove failed: ${msg}` }) }],
            isError: true,
          };
        }

        activeWorktrees.delete(targetPath);
        effectiveCwd = originalRepo;
        options.onSetCwd?.(originalRepo);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              removedWorktree: targetPath,
              restoredCwd: originalRepo,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // ── Command tools ─────────────────────────────────────────────────────────────
  // Obsidian's command registry is not in the official TS types; cast via unknown.
  type ObsidianCommandsRegistry = {
    commands: Record<string, { id: string; name: string }>;
    executeCommandById: (id: string) => boolean;
  };

  const boundListCommands = tool(
    'obsidian_list_commands',
    'Returns all registered Obsidian commands with their ID and name, sorted alphabetically by ID. Optionally filter by a query string. Use this to discover command IDs before calling obsidian_execute_command.',
    listCommandsSchema,
    async (args, _extra) => {
      try {
        const registry = (app as unknown as { commands: ObsidianCommandsRegistry }).commands;
        const all = Object.values(registry.commands);
        const { query } = args;
        const filtered = query
          ? all.filter(
              (cmd) =>
                cmd.id.toLowerCase().includes(query.toLowerCase()) ||
                cmd.name.toLowerCase().includes(query.toLowerCase()),
            )
          : all;
        filtered.sort((a, b) => a.id.localeCompare(b.id));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundExecuteCommand = tool(
    'obsidian_execute_command',
    'Executes an Obsidian command by its ID (e.g. "obsidian-git:push", "editor:toggle-bold"). Use obsidian_list_commands to discover available command IDs. Returns success or failure.',
    executeCommandSchema,
    async (args, _extra) => {
      try {
        const registry = (app as unknown as { commands: ObsidianCommandsRegistry }).commands;
        if (!(args.commandId in registry.commands)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Unknown command: "${args.commandId}". Use obsidian_list_commands to see available commands.`,
              }, null, 2),
            }],
            isError: true,
          };
        }
        const ok = registry.executeCommandById(args.commandId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: ok, commandId: args.commandId }, null, 2),
          }],
          ...(ok ? {} : { isError: true }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  const boundForkConversation = tool(
    'fork_conversation',
    [
      'Forks the current conversation into a new, self-contained thread.',
      'A separate Claude call distills the conversation history into a focused starting prompt for the new thread.',
      'The new thread inherits the same working directory and project as the current one.',
      'Use this when the conversation has grown long, when you want to explore a different angle without losing the current thread,',
      'or when the user asks to start fresh with focused context.',
      'The current thread continues unaffected — the fork is a new independent thread.',
    ].join(' '),
    {
      focus_area: z
        .string()
        .optional()
        .describe(
          'What the new thread should focus on. Examples: "the auth bug", "refactoring the API layer", "next deployment steps". Leave empty to continue and extend the current work.',
        ),
    },
    async (args, _extra) => {
      if (!options.onForkRequested) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'fork_conversation is not available in this context.' }) }],
          isError: true,
        };
      }
      try {
        const { threadTitle } = await options.onForkRequested(args.focus_area ?? '');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              threadTitle,
              message: `Fork created: "${threadTitle}". The user can switch to it from the notification that appeared in Obsidian.`,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
          isError: true,
        };
      }
    },
  );

  // ── Thread-coordination tools ────────────────────────────────────────────────

  const boundGetCurrentThread = tool(
    'obsidian_get_current_thread',
    'Returns metadata about the current thread: id, title, status, isRunning, project, cwd, and message count. Useful for understanding your own context before coordinating with other threads.',
    {},
    async (_args, _extra) => {
      try {
        const { threadId } = options;
        if (!threadId || !options.getThreadDetail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        const detail = options.getThreadDetail(threadId);
        if (!detail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Current thread not found: ${threadId}` }) }], isError: true };
        }
        const { messages: _msgs, ...meta } = detail;
        return { content: [{ type: 'text' as const, text: JSON.stringify(meta, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundListThreads = tool(
    'obsidian_list_threads',
    'Returns all threads with their id, title, status, isRunning flag, project, cwd, updatedAt, and message count. Use this to discover other running threads before coordinating with them.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.getAllThreads) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        const threads = options.getAllThreads();
        return { content: [{ type: 'text' as const, text: JSON.stringify(threads, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundListProjects = tool(
    'obsidian_list_projects',
    'Returns all projects with their id, name, description, and vaultFolder. Useful for understanding what workspaces exist and which cwd a new thread should use.',
    {},
    async (_args, _extra) => {
      try {
        if (!options.getAllProjects) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Project state not available in this context.' }) }], isError: true };
        }
        const projects = options.getAllProjects();
        return { content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
    { alwaysLoad: true },
  );

  const boundGetThreadMessages = tool(
    'obsidian_get_thread_messages',
    'Returns the live message history of any thread by ID. Use limit to get just the most recent N messages (default 20). Useful for reading what another thread has done or decided before coordinating.',
    {
      threadId: z.string().describe('ID of the thread to read'),
      limit: z.number().int().positive().optional().describe('Return only the last N messages (default 20)'),
    },
    async (args, _extra) => {
      try {
        if (!options.getThreadDetail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        const detail = options.getThreadDetail(args.threadId);
        if (!detail) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Thread not found: ${args.threadId}` }) }], isError: true };
        }
        const limit = args.limit ?? 20;
        const messages = detail.messages.slice(-limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundWaitForThread = tool(
    'obsidian_wait_for_thread',
    'Blocks until the specified thread finishes processing its current request (isRunning becomes false), then returns. Returns immediately if the thread is already idle. Use after obsidian_send_message_to_thread to wait for a response before reading results.',
    {
      threadId: z.string().describe('ID of the thread to wait for'),
      timeoutSeconds: z.number().optional().describe('Maximum seconds to wait before giving up (default 120)'),
    },
    async (args, _extra) => {
      try {
        if (!options.isThreadRunning) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread state not available in this context.' }) }], isError: true };
        }
        const timeoutMs = Math.min((args.timeoutSeconds ?? 120) * 1000, 600_000);
        const start = Date.now();
        const pollMs = 1_000;

        while (options.isThreadRunning(args.threadId)) {
          const elapsed = Date.now() - start;
          if (elapsed >= timeoutMs) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ done: false, timedOut: true, elapsedSeconds: Math.round(elapsed / 1000) }) }],
              isError: true,
            };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ done: true, elapsedSeconds: Math.round((Date.now() - start) / 1000) }) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  const boundSendMessageToThread = tool(
    'obsidian_send_message_to_thread',
    'Sends a user message to another thread, triggering Claude to process it. The call returns as soon as the message is queued — use obsidian_wait_for_thread to block until the response is ready. Cannot send to the current thread.',
    {
      threadId: z.string().describe('ID of the thread to send the message to'),
      message: z.string().describe('The message text to send'),
    },
    async (args, _extra) => {
      try {
        if (!options.sendMessageToThread) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Thread messaging not available in this context.' }) }], isError: true };
        }
        if (args.threadId === options.threadId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Cannot send a message to the current thread.' }) }], isError: true };
        }
        await options.sendMessageToThread(args.threadId, args.message);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, threadId: args.threadId }) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── Vault Bridges tools ───────────────────────────────────────────────────
  // These reach into the vault-bridges plugin API (if installed) so agents can
  // inspect and configure bridges without editing data.json or restarting Obsidian.

  type VaultBridgesPlugin = {
    api: {
      getBridges(): Array<{
        id: string;
        name: string;
        repoPath: string;
        sourcePath: string;
        vaultPath: string;
        branch: string;
        autoSync: boolean;
        status: string;
        lastSynced?: string;
        lastPulled?: string;
        lastPushed?: string;
        isDirty?: boolean;
        lastError?: string;
      }>;
      addBridge(options: {
        name: string;
        repoPath: string;
        vaultPath: string;
        sourcePath?: string;
        branch?: string;
        autoSync?: boolean;
        syncNow?: boolean;
      }): Promise<{ id: string; name: string; repoPath: string; vaultPath: string; branch: string; status: string }>;
    };
  };

  function getVaultBridgesPlugin(): VaultBridgesPlugin | null {
    return (app as unknown as { plugins: { plugins: Record<string, unknown> } })
      .plugins?.plugins?.['vault-bridges'] as VaultBridgesPlugin | null ?? null;
  }

  const boundListVaultBridges = tool(
    'obsidian_list_vault_bridges',
    'Returns all configured Vault Bridges. Use this before adding a bridge to avoid duplicates. Returns an empty array if the vault-bridges plugin is not installed.',
    {},
    async (_args, _extra) => {
      try {
        const vb = getVaultBridgesPlugin();
        if (!vb) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'vault-bridges plugin is not installed or not enabled.' }),
            }],
            isError: true,
          };
        }
        const bridges = vb.api.getBridges();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(bridges, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  const boundAddVaultBridge = tool(
    'obsidian_add_vault_bridge',
    [
      'Adds a new Vault Bridge (a live link between a local git repo and a vault folder).',
      'If a bridge with the same repoPath + vaultPath already exists, the existing bridge is returned without creating a duplicate.',
      'Call obsidian_list_vault_bridges first to check what is already configured.',
      'Requires the vault-bridges plugin to be installed and enabled.',
    ].join(' '),
    addVaultBridgeSchema,
    async (args, _extra) => {
      try {
        const vb = getVaultBridgesPlugin();
        if (!vb) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'vault-bridges plugin is not installed or not enabled.' }),
            }],
            isError: true,
          };
        }
        const bridge = await vb.api.addBridge({
          name: args.name,
          repoPath: args.repoPath,
          vaultPath: args.vaultPath,
          sourcePath: args.sourcePath,
          branch: args.branch,
          autoSync: args.autoSync,
          syncNow: args.syncNow,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(bridge, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  return createSdkMcpServer({
    name: 'obsidian',
    tools: [
      boundGetOpenTabs,
      boundGetActiveFile,
      boundNavigateToFile,
      boundSearchVault,
      boundGetBacklinks,
      boundGetOutgoingLinks,
      boundInsertAtCursor,
      boundGetNoteMetadata,
      boundSetWorkingDirectory,
      boundScheduleWakeup,
      boundEnterWorktree,
      boundExitWorktree,
      boundListCommands,
      boundExecuteCommand,
      boundForkConversation,
      boundGetCurrentThread,
      boundListThreads,
      boundListProjects,
      boundGetThreadMessages,
      boundWaitForThread,
      boundSendMessageToThread,
      boundListVaultBridges,
      boundAddVaultBridge,
    ],
    alwaysLoad: true,
  });
}

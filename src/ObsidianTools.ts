import { z } from 'zod';
// Import from the browser entry point to avoid Node.js-only APIs (e.g. setTimeout().unref())
// that crash in Electron's renderer context.
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk/browser';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { App, TFile } from 'obsidian';
import fs from 'fs';
import os from 'os';
import { tokenizeQuery, findBestExcerpt } from './searchUtils';

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

// ── Factory ──────────────────────────────────────────────────────────────────

export interface ObsidianMcpServerOptions {
  /** Called when the agent requests a working-directory change. Receives the resolved absolute path. */
  onSetCwd?: (path: string) => void;
  /** Called when the agent schedules a wakeup. delayMs is the delay in milliseconds. */
  onScheduleWakeup?: (delayMs: number, prompt: string, reason: string) => void;
}

/**
 * Creates an MCP server config with Obsidian-specific tools bound to the given App instance.
 * Pass the result as `{ obsidian: createObsidianMcpServer(this.app) }` in the `mcpServers` option.
 */
export function createObsidianMcpServer(app: App, options: ObsidianMcpServerOptions = {}): McpSdkServerConfigWithInstance {
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
    ],
    alwaysLoad: true,
  });
}

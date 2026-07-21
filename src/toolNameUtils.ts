/**
 * toolNameUtils.ts
 *
 * Pure string-manipulation helpers for displaying tool names and picking icons.
 * Intentionally has ZERO imports so this module is safe to include in the
 * mobile bundle (which cannot load Node.js built-ins or the Claude SDK).
 *
 * Previously these functions lived in ClaudeSession.ts, which imports the SDK
 * at the top level. That caused a crash on mobile: the SDK's module-level
 * `import { execFile } from "child_process"` became `require('child_process')`
 * in the CJS bundle, which returns null on mobile, immediately throwing
 * TypeError when the bundle tried to destructure it.
 */

/** Strip `mcp__<server>__` prefix and any leading server-name repetition.
 *  e.g. mcp__obsidian__obsidian_search_vault → "search vault"
 *       mcp__github__create_issue           → "create issue"
 *       Read                                → "Read"
 */
export function formatToolName(raw: string): string {
  // Strip mcp__<server>__ prefix
  const mcpMatch = raw.match(/^mcp__[^_]+__(.+)$/);
  const bare = mcpMatch ? mcpMatch[1] : raw;
  // If bare still starts with a repeated server name segment, drop it.
  // e.g. obsidian_search_vault → strip leading "obsidian_"
  const deduplicated = bare.replace(/^([a-z]+)_\1_/, '$1_').replace(/^[a-z]+_([a-z].+)$/, (_, rest) => {
    // Only strip if the prefix is the server name from the original mcp call
    if (mcpMatch) {
      const server = raw.match(/^mcp__([^_]+)__/)![1];
      const serverSnake = server + '_';
      if (bare.startsWith(serverSnake)) return bare.slice(serverSnake.length);
    }
    return bare;
  });
  // Convert underscores to spaces for display
  return deduplicated.replace(/_/g, ' ');
}

/** Return a Lucide icon name for a tool. Falls back to 'wrench'. */
export function getToolIcon(raw: string): string {
  // Normalize first so we can match on bare names
  const mcpMatch = raw.match(/^mcp__[^_]+__(.+)$/);
  const bare = mcpMatch ? mcpMatch[1] : raw;
  const server = mcpMatch ? raw.match(/^mcp__([^_]+)__/)![1] : null;

  // Strip leading server prefix for MCP tools
  const key = (server && bare.startsWith(server + '_'))
    ? bare.slice(server.length + 1)
    : bare;

  switch (key) {
    // Filesystem / code tools
    case 'Read':           return 'file-text';
    case 'Edit':           return 'file-pen';
    case 'Write':          return 'file-plus';
    case 'Glob':           return 'folder-search';
    case 'Grep':           return 'search-code';
    case 'Bash':           return 'terminal';
    case 'REPL':           return 'code-2';
    // Web tools
    case 'WebFetch':       return 'globe';
    case 'WebSearch':      return 'search';
    // Claude-native
    case 'Agent':          return 'bot';
    case 'OpenNewTab':     return 'plus-square';
    case 'TodoWrite':      return 'list-checks';
    // MCP resource tools
    case 'ListMcpResources':    return 'database';
    case 'ReadMcpResource':     return 'database';
    case 'ReadMcpResourceDir':  return 'folder-open';
    case 'AskUserQuestion': return 'message-circle-question';
    case 'Skill':          return 'puzzle';
    case 'Workflow':       return 'workflow';
    case 'ToolSearch':     return 'search-code';
    // Task tools
    case 'TaskCreate':     return 'clipboard-plus';
    case 'TaskUpdate':     return 'clipboard-pen';
    case 'TaskGet':        return 'clipboard-list';
    case 'TaskList':       return 'list-todo';
    case 'TaskStop':       return 'circle-stop';
    case 'TaskOutput':     return 'scroll-text';
    case 'Monitor':        return 'activity';
    case 'RemoteTrigger':  return 'radio-tower';
    // Obsidian MCP
    case 'search_vault':         return 'vault';
    case 'navigate_to_file':     return 'navigation';
    case 'get_active_file':      return 'file-search';
    case 'insert_at_cursor':     return 'text-cursor-input';
    case 'get_note_metadata':    return 'info';
    case 'get_backlinks':        return 'link-2';
    case 'get_outgoing_links':   return 'external-link';
    case 'set_working_directory': return 'folder-symlink';
    case 'enter_worktree':       return 'git-branch-plus';
    case 'exit_worktree':        return 'git-branch';
    case 'get_open_tabs':        return 'layout-panel-top';
    case 'ScheduleWakeup':       return 'alarm-clock';
    default:               return 'wrench';
  }
}

/**
 * Buckets a tool name into a coarse "activity" category so consecutive
 * same-kind tool calls can be visually grouped in the finalized message view
 * (see groupToolCalls below). Reuses the same MCP-prefix-stripping logic as
 * getToolIcon so `mcp__server__Bash`-shaped names classify the same as bare
 * `Bash`.
 */
export type ActivityKind = 'exploring' | 'editing' | 'planning' | 'researching' | 'searching' | 'working';

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  exploring: 'Exploring',
  editing: 'Editing',
  planning: 'Planning',
  researching: 'Researching',
  searching: 'Searching',
  working: 'Working',
};

export function getActivityKind(raw: string): ActivityKind {
  // Normalize the same way getToolIcon does so MCP-prefixed tool names
  // (e.g. mcp__obsidian__Bash) classify identically to bare names.
  const mcpMatch = raw.match(/^mcp__[^_]+__(.+)$/);
  const bare = mcpMatch ? mcpMatch[1] : raw;
  const server = mcpMatch ? raw.match(/^mcp__([^_]+)__/)![1] : null;
  const key = (server && bare.startsWith(server + '_'))
    ? bare.slice(server.length + 1)
    : bare;

  switch (key) {
    case 'Bash':
    case 'Read':
    case 'Grep':
    case 'Glob':
      return 'exploring';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'editing';
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return 'planning';
    case 'WebFetch':
    case 'WebSearch':
      return 'researching';
    case 'ToolSearch':
    case 'Agent':
      return 'searching';
    default:
      return 'working';
  }
}

/** One entry in the finalized-message tool-call rendering list. */
export type ToolCallGroup =
  | { kind: 'single'; tool: import('./types').ToolCallRecord }
  | { kind: 'group'; activityKind: ActivityKind; tools: import('./types').ToolCallRecord[] };

/**
 * Chunks a flat list of tool calls into runs of consecutive same-activity-kind
 * calls. Runs of length >= 2 become a single collapsible 'group' entry;
 * isolated calls (no same-kind neighbor immediately before/after) stay as
 * 'single' entries so they render exactly as they always have — no pointless
 * one-item collapsibles. Pure function, no DOM access.
 */
export function groupToolCalls(tools: import('./types').ToolCallRecord[]): ToolCallGroup[] {
  const result: ToolCallGroup[] = [];
  let i = 0;
  while (i < tools.length) {
    const kind = getActivityKind(tools[i].name);
    let j = i + 1;
    while (j < tools.length && getActivityKind(tools[j].name) === kind) {
      j++;
    }
    const run = tools.slice(i, j);
    if (run.length >= 2) {
      result.push({ kind: 'group', activityKind: kind, tools: run });
    } else {
      result.push({ kind: 'single', tool: run[0] });
    }
    i = j;
  }
  return result;
}

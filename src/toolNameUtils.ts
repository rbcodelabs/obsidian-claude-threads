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

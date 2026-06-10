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

/**
 * Produce a short human-readable summary string for a tool call.
 * Used by AnthropicProvider to populate ToolCallRecord.summary for display.
 * Kept in toolNameUtils so it stays mobile-safe (no SDK imports).
 */
export function formatToolSummary(name: string, input: Record<string, unknown>): string {
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  const bare = mcpMatch ? mcpMatch[1] : name;
  const server = mcpMatch ? name.match(/^mcp__([^_]+)__/)![1] : null;
  const key = (server && bare.startsWith(server + '_'))
    ? bare.slice(server.length + 1)
    : bare;

  switch (key) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'Glob':
    case 'Grep':
      return `${String(input.file_path ?? input.path ?? input.pattern ?? '')}`;
    case 'Bash':
      return `${String(input.command ?? '').substring(0, 60)}`;
    case 'WebFetch':
      return `${input.url}`;
    case 'WebSearch':
      return `${input.query}`;
    case 'OpenNewTab':
      return `${(input.title as string) ?? 'New Thread'}`;
    case 'navigate_to_file': return `${input.path}`;
    case 'search_vault': return `${input.query}`;
    case 'get_backlinks': return `${input.path}`;
    case 'get_outgoing_links': return `${input.path}`;
    case 'insert_at_cursor': return '';
    case 'get_note_metadata': return `${input.path}`;
    case 'set_working_directory': return `${input.path}`;
    default:
      return '';
  }
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
    // Web tools
    case 'WebFetch':       return 'globe';
    case 'WebSearch':      return 'search';
    // Claude-native
    case 'Agent':          return 'bot';
    case 'OpenNewTab':     return 'plus-square';
    case 'TodoWrite':      return 'list-checks';
    case 'AskUserQuestion': return 'message-circle-question';
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

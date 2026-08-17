import { describe, expect, it } from 'vitest';
import { formatToolName, getActivityKind, getToolIcon } from '../../src/toolNameUtils';

describe('host-neutral tool display', () => {
  it('formats canonical fully-qualified names without leaking the server name', () => {
    expect(formatToolName('mcp__claude_threads__vault_search')).toBe('vault search');
    expect(formatToolName('mcp__claude_threads__threads_send_message')).toBe('threads send message');
    expect(getToolIcon('mcp__claude_threads__vault_search')).toBe('vault');
    expect(getActivityKind('mcp__claude_threads__Bash')).toBe('exploring');
  });

  it('keeps legacy display compatibility', () => {
    expect(formatToolName('mcp__obsidian__obsidian_search_vault')).toBe('search vault');
  });
});

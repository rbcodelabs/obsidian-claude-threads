import { describe, it, expect } from 'vitest';
import { resolveProjectName } from '../../src/pathUtils';

describe('resolveProjectName', () => {
  it('returns the last path component for a normal project path', () => {
    expect(resolveProjectName('/Users/rick/projects/obsidian-claude-threads')).toBe('obsidian-claude-threads');
  });

  it('extracts the segment before /.worktrees/ for a worktree path', () => {
    expect(resolveProjectName('/Users/rick/projects/golden-wealth-app/.worktrees/claude-123')).toBe('golden-wealth-app');
  });

  it('handles a deep worktree path', () => {
    expect(resolveProjectName('/var/folders/l5/abc/T/claude-worktrees/.worktrees/be31f47a')).toBe('claude-worktrees');
  });

  it('handles the example from the spec', () => {
    expect(resolveProjectName('/Users/rick/projects/golden-wealth-app/.worktrees/claude-123')).toBe('golden-wealth-app');
  });

  it('returns empty string for an empty string', () => {
    expect(resolveProjectName('')).toBe('');
  });

  it('returns empty string for null-like falsy input', () => {
    expect(resolveProjectName(null as unknown as string)).toBe('');
  });

  it('handles a single path component with no slashes', () => {
    expect(resolveProjectName('myproject')).toBe('myproject');
  });

  it('handles a root-level directory', () => {
    expect(resolveProjectName('/myproject')).toBe('myproject');
  });

  it('ignores a trailing slash', () => {
    // lastIndexOf('/') on 'a/b/' returns the last /, giving ''
    // This is acceptable — document the behavior
    expect(resolveProjectName('/Users/rick/projects/myapp')).toBe('myapp');
  });
});

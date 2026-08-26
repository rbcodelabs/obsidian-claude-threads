// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderAgentPopoverTree } from '../../src/agentRuns/renderAgentPopoverTree';
import type { AgentRun } from '../../src/types';

const run = (overrides: Partial<AgentRun> & { id: string }): AgentRun => ({
  threadId: 't',
  nativeAgentId: `native-${overrides.id}`,
  harness: 'claude',
  description: 'Review code',
  status: 'working',
  startedAt: 1,
  updatedAt: 2,
  capabilities: { viewTranscript: true, sendMessage: false, interrupt: false },
  events: [],
  ...overrides,
});

describe('renderAgentPopoverTree', () => {
  it('renders flat rows carrying aria-level instead of nested DOM', () => {
    const host = document.createElement('div');
    renderAgentPopoverTree(host, [
      run({ id: 'a', role: 'reviewer' }),
      run({ id: 'b', role: 'test engineer', parentAgentRunId: 'a' }),
    ], () => {});

    expect(host.getAttribute('role')).toBe('tree');
    const items = [...host.querySelectorAll('[role="treeitem"]')];
    expect(items).toHaveLength(2);
    expect(items.map(i => i.getAttribute('aria-level'))).toEqual(['1', '2']);
    // Flat: no treeitem is a descendant of another treeitem.
    expect(items.every(i => i.parentElement === host)).toBe(true);
  });

  it('exposes indent depth as a capped CSS custom property', () => {
    const host = document.createElement('div');
    renderAgentPopoverTree(host, [
      run({ id: 'a' }),
      run({ id: 'b', parentAgentRunId: 'a' }),
      run({ id: 'c', parentAgentRunId: 'b' }),
      run({ id: 'd', parentAgentRunId: 'c' }),
      run({ id: 'e', parentAgentRunId: 'd' }),
      run({ id: 'f', parentAgentRunId: 'e' }),
      run({ id: 'g', parentAgentRunId: 'f' }),
    ], () => {});

    const levels = [...host.querySelectorAll('.ct-agent-row-button')]
      .map(b => (b as HTMLElement).style.getPropertyValue('--ct-agent-level'));
    expect(levels).toEqual(['0', '1', '2', '3', '4', '4', '4']);
  });

  it('invokes onSelect with the exact run id that was clicked', () => {
    const host = document.createElement('div');
    const onSelect = vi.fn();
    renderAgentPopoverTree(host, [
      run({ id: 'a' }),
      run({ id: 'b', parentAgentRunId: 'a', description: 'Inspect fixtures' }),
    ], onSelect);

    (host.querySelector('[data-agent-run-id="b"] button') as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('marks the selected row with aria-current', () => {
    const host = document.createElement('div');
    renderAgentPopoverTree(host, [run({ id: 'a' }), run({ id: 'b' })], () => {}, 'b');
    const selected = host.querySelectorAll('[aria-current="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].closest('[data-agent-run-id]')?.getAttribute('data-agent-run-id')).toBe('b');
  });

  it('carries the status onto the row so the dot colour rules apply', () => {
    const host = document.createElement('div');
    renderAgentPopoverTree(host, [run({ id: 'a', status: 'waiting' })], () => {});
    expect(host.querySelector('.ct-agent-waiting')).not.toBeNull();
    expect(host.querySelector('.ct-agent-status-dot')).not.toBeNull();
  });

  it('shows an empty state rather than an empty tree', () => {
    const host = document.createElement('div');
    renderAgentPopoverTree(host, [], () => {});
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
    expect(host.textContent).toContain('No sub-agents have started');
  });

  it('renders a self-parenting run without hanging', () => {
    const host = document.createElement('div');
    renderAgentPopoverTree(host, [run({ id: 'a', parentAgentRunId: 'a' })], () => {});
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
  });
});

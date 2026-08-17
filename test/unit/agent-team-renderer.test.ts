// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderAgentTeam } from '../../src/agentRuns/renderAgentTeam';
import type { AgentRun } from '../../src/types';

const run = (overrides: Partial<AgentRun>): AgentRun => ({
  id: 'parent', threadId: 't', nativeAgentId: 'native-parent', harness: 'claude', description: 'Review code', status: 'working',
  startedAt: 1, updatedAt: 2, capabilities: { viewTranscript: true, sendMessage: false, interrupt: false }, events: [], ...overrides,
});

describe('renderAgentTeam', () => {
  it('renders an accessible nested tree and opens exact agent activity', () => {
    const host = document.createElement('div');
    const selected = vi.fn();
    renderAgentTeam(host, [run({}), run({ id: 'child', nativeAgentId: 'native-child', parentAgentRunId: 'parent', description: 'Inspect fixtures', currentActivity: 'Reading tests', events: [{ kind: 'activity', text: 'Reading tests', timestamp: 3 }] })], selected);
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
    (host.querySelector('[data-agent-run-id="child"] button') as HTMLButtonElement).click();
    expect(selected).toHaveBeenCalledWith('child');
  });

  it('explains capability gating in the detail panel', () => {
    const host = document.createElement('div');
    renderAgentTeam(host, [run({ events: [{ kind: 'tool', text: 'Running tests', toolName: 'Bash', timestamp: 3 }] })], () => {}, 'parent');
    expect(host.textContent).toContain('Direct messaging and single-agent interruption are not exposed by this harness.');
    expect(host.textContent).toContain('Running tests');
    expect(host.querySelector('button[aria-label="Message agent"]')).toBeNull();
  });
});

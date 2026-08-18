// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../../src/types';
import { agentStatusCounts, buildAgentConversation, renderAgentStatusPill } from '../../src/agentRuns/agentConversation';

const run = (patch: Partial<AgentRun> = {}): AgentRun => ({
  id: 'child', threadId: 'thread', nativeAgentId: 'native-child', harness: 'claude',
  description: 'Research the protocol', status: 'working', startedAt: 1, updatedAt: 2,
  capabilities: { viewTranscript: false, sendMessage: false, interrupt: false },
  events: [{ kind: 'activity', text: 'Reading SDK types', timestamp: 2 }], ...patch,
});

describe('agent conversation view model', () => {
  it('aggregates active, complete, and attention states', () => {
    expect(agentStatusCounts([
      run({ id: 'a', status: 'starting' }), run({ id: 'b', status: 'working' }),
      run({ id: 'c', status: 'completed' }), run({ id: 'd', status: 'failed' }),
      run({ id: 'e', status: 'interrupted' }),
    ])).toEqual({ active: 2, completed: 1, failed: 2 });
  });

  it('builds nested breadcrumbs and honestly labels summary-only data as activity', () => {
    const parent = run({ id: 'parent', nativeAgentId: 'p', role: 'researcher' });
    const child = run({ id: 'child', parentAgentRunId: 'parent', role: 'analyst' });
    expect(buildAgentConversation([parent, child], 'child')).toMatchObject({
      title: 'Agent activity', kind: 'activity', breadcrumbs: [
        { label: 'Main conversation' }, { label: 'researcher', agentRunId: 'parent' }, { label: 'analyst', agentRunId: 'child' },
      ],
    });
  });

  it('uses transcript wording only when native transcript messages are captured', () => {
    const transcript = run({
      capabilities: { viewTranscript: true, sendMessage: false, interrupt: false },
      transcript: [{ role: 'assistant', text: 'I found the issue', timestamp: 3 }],
    } as Partial<AgentRun>);
    expect(buildAgentConversation([transcript], 'child')).toMatchObject({ title: 'Agent conversation', kind: 'transcript' });
  });

  it('renders a compact accessible pill and hides it when there are no runs', () => {
    const button = document.createElement('button');
    renderAgentStatusPill(button, []);
    expect(button.hidden).toBe(true);
    renderAgentStatusPill(button, [run({ status: 'working' }), run({ id: 'done', status: 'completed' }), run({ id: 'bad', status: 'failed' })]);
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('View agent team: 1 active, 1 completed, 1 needs attention');
    expect(button.querySelector('.ct-agent-status-active span:last-child')?.textContent).toBe('1');
    expect(button.querySelector('.ct-agent-status-failed span:last-child')?.textContent).toBe('1');
  });
});

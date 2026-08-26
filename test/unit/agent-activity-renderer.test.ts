// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderAgentActivity } from '../../src/agentRuns/renderAgentActivity';
import type { AgentRun } from '../../src/types';

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'a',
  threadId: 't',
  nativeAgentId: 'native-a',
  harness: 'claude',
  description: 'Review authentication flow',
  status: 'working',
  startedAt: 1,
  updatedAt: 2,
  capabilities: { viewTranscript: true, sendMessage: false, interrupt: false },
  events: [],
  ...overrides,
});

describe('renderAgentActivity', () => {
  it('renders the timeline in chronological order regardless of input order', () => {
    const host = document.createElement('div');
    renderAgentActivity(host, run({
      events: [
        { kind: 'activity', text: 'Second', timestamp: 200 },
        { kind: 'lifecycle', text: 'First', timestamp: 100 },
      ],
    }));
    const texts = [...host.querySelectorAll('.ct-agent-event span')].map(e => e.textContent);
    expect(texts).toEqual(['First', 'Second']);
  });

  it('prefixes the tool name on tool events', () => {
    const host = document.createElement('div');
    renderAgentActivity(host, run({ events: [{ kind: 'tool', text: 'Running tests', toolName: 'Bash', timestamp: 3 }] }));
    expect(host.textContent).toContain('Bash: Running tests');
  });

  it('shows harness, status and model in the meta line', () => {
    const host = document.createElement('div');
    renderAgentActivity(host, run({ model: 'claude-sonnet-4-5' }));
    expect(host.querySelector('.ct-agent-meta')?.textContent).toBe('claude · working · claude-sonnet-4-5');
  });

  it('explains an empty timeline instead of rendering nothing', () => {
    const host = document.createElement('div');
    renderAgentActivity(host, run());
    expect(host.textContent).toContain('No detailed activity has been exposed by the harness yet.');
  });

  it('explains capability gating and offers no message control', () => {
    const host = document.createElement('div');
    renderAgentActivity(host, run());
    expect(host.querySelector('.ct-agent-capability-note')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Message agent"]')).toBeNull();
  });

  it('omits the capability note when the harness does expose controls', () => {
    const host = document.createElement('div');
    renderAgentActivity(host, run({ capabilities: { viewTranscript: true, sendMessage: true, interrupt: true } }));
    expect(host.querySelector('.ct-agent-capability-note')).toBeNull();
  });

  it('surfaces a failure message', () => {
    const host = document.createElement('div');
    renderAgentActivity(host, run({ status: 'failed', error: 'Tool exited 1' }));
    expect(host.querySelector('.ct-agent-error-note')?.textContent).toBe('Tool exited 1');
  });

  it('replaces prior content on re-render rather than appending', () => {
    const host = document.createElement('div');
    renderAgentActivity(host, run({ events: [{ kind: 'activity', text: 'One', timestamp: 1 }] }));
    renderAgentActivity(host, run({ events: [{ kind: 'activity', text: 'One', timestamp: 1 }, { kind: 'activity', text: 'Two', timestamp: 2 }] }));
    expect(host.querySelectorAll('.ct-agent-event')).toHaveLength(2);
    expect(host.querySelectorAll('.ct-agent-timeline')).toHaveLength(1);
  });
});

/**
 * orchestrator-badge.test.ts
 * @vitest-environment jsdom
 *
 * Unit tests for appendOrchestratorBadge (src/orchestrator-badge.ts), the
 * shared helper that marks the thread running the bundled orchestrator skill
 * across the Agent Dashboard, Kanban board, and thread switcher.
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom

import { describe, it, expect } from 'vitest';
import { appendOrchestratorBadge } from '../../src/orchestrator-badge';

describe('appendOrchestratorBadge', () => {
  it('renders the badge span when threadId matches orchestratorThreadId', () => {
    const parent = document.createElement('div');
    appendOrchestratorBadge(parent, 'thread-1', 'thread-1');

    const badge = parent.querySelector('.ct-orchestrator-badge');
    expect(badge).not.toBeNull();
  });

  it('does nothing when threadId does not match orchestratorThreadId', () => {
    const parent = document.createElement('div');
    appendOrchestratorBadge(parent, 'thread-1', 'thread-2');

    expect(parent.querySelector('.ct-orchestrator-badge')).toBeNull();
    expect(parent.childElementCount).toBe(0);
  });

  it('does nothing when orchestratorThreadId is undefined', () => {
    const parent = document.createElement('div');
    appendOrchestratorBadge(parent, 'thread-1', undefined);

    expect(parent.querySelector('.ct-orchestrator-badge')).toBeNull();
    expect(parent.childElementCount).toBe(0);
  });
});

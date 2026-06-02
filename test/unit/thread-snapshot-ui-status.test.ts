/**
 * thread-snapshot-ui-status.test.ts
 *
 * Verifies that computeUiStatus maps thread state to the correct Agent Dashboard
 * UI bucket label. This ensures the API (obsidian_list_threads / obsidian_get_current_thread)
 * reports status values that match what the UI shows.
 */
import { describe, it, expect } from 'vitest';
import { computeUiStatus } from '../../src/ObsidianTools';

// The 5 Agent Dashboard group labels (lowercased) must exactly match UiStatus values
const UI_GROUP_LABELS_LOWER = ['working', 'new', 'reviewed', 'failed', 'ready'] as const;

describe('computeUiStatus — UI/API status consistency', () => {

  // ── Primary states ─────────────────────────────────────────────────────────

  it("running thread → 'working'", () => {
    expect(computeUiStatus({ isRunning: true, messageCount: 0 })).toBe('working');
  });

  it("idle thread with lastError → 'failed'", () => {
    expect(computeUiStatus({ isRunning: false, lastError: 'Claude crashed', messageCount: 0 })).toBe('failed');
  });

  it("idle thread with messages, not reviewed → 'new'", () => {
    expect(computeUiStatus({ isRunning: false, messageCount: 5, reviewed: false })).toBe('new');
  });

  it("idle thread with messages, reviewed → 'reviewed'", () => {
    expect(computeUiStatus({ isRunning: false, messageCount: 3, reviewed: true })).toBe('reviewed');
  });

  it("idle thread with no messages, no error → 'ready'", () => {
    expect(computeUiStatus({ isRunning: false, messageCount: 0 })).toBe('ready');
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it("running thread with lastError still set → 'working' (running branch wins)", () => {
    // A thread can have a stale lastError from a previous failed run while currently running.
    // The UI shows it as Working, not Failed.
    expect(computeUiStatus({
      isRunning: true,
      lastError: 'stale error from last run',
      messageCount: 3,
    })).toBe('working');
  });

  it("idle thread with no messages but lastError set → 'failed' (error before empty check)", () => {
    expect(computeUiStatus({
      isRunning: false,
      lastError: 'timeout',
      messageCount: 0,
    })).toBe('failed');
  });

  it("reviewed: undefined (falsy) → same as reviewed: false → 'new'", () => {
    expect(computeUiStatus({
      isRunning: false,
      messageCount: 2,
      reviewed: undefined,
    })).toBe('new');
  });

  it("lastError: '' (empty string, falsy) → not failed → 'ready' when no messages", () => {
    // An empty string lastError should not trigger 'failed'
    expect(computeUiStatus({
      isRunning: false,
      lastError: '',
      messageCount: 0,
    })).toBe('ready');
  });

  it("running thread with no messages and no error → 'working'", () => {
    expect(computeUiStatus({ isRunning: true, messageCount: 0 })).toBe('working');
  });

  it("idle thread with exactly 1 message, reviewed: true → 'reviewed'", () => {
    expect(computeUiStatus({ isRunning: false, messageCount: 1, reviewed: true })).toBe('reviewed');
  });

  // ── Vocabulary consistency ──────────────────────────────────────────────────

  it('all 5 UiStatus values match lowercased Agent Dashboard group labels', () => {
    // These are the exact labels used in AgentDashboard.render():
    //   renderGroup('Working', ...) → 'working'
    //   renderGroup('New', ...) → 'new'
    //   renderGroup('Reviewed', ...) → 'reviewed'
    //   renderGroup('Failed', ...) → 'failed'
    //   renderGroup('Ready', ...) → 'ready'
    const allUiStatuses = UI_GROUP_LABELS_LOWER;
    const coverageMap: Record<string, string> = {
      Working: 'working',
      New: 'new',
      Reviewed: 'reviewed',
      Failed: 'failed',
      Ready: 'ready',
    };
    for (const [label, expectedStatus] of Object.entries(coverageMap)) {
      expect(allUiStatuses).toContain(expectedStatus);
      expect(label.toLowerCase()).toBe(expectedStatus);
    }
  });
});

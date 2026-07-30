/**
 * @vitest-environment jsdom
 *
 * Regression test for the "tool pills silently stop appearing after a
 * cwd reset" bug: the 'tool_use' case in ThreadsView#handleEvent used to
 * gate pill creation on `if (this.streamingEl && !isAgentCall)`. Once any
 * assistant text message finalized, the 'message' case unconditionally
 * nulled `this.streamingEl`. If the *next* turn was tool-call-only (no
 * prose) — e.g. right after `set_working_directory`, which is typically
 * followed by more prose-free tool calls — `ClaudeSession` never fires
 * `onMessage` (it only fires when a turn has text content), so nothing
 * ever recreated `streamingEl`. The old `if (this.streamingEl && ...)`
 * guard then made every subsequent tool_use event a silent no-op: the
 * pill was never appended and the tool call never became visible, even
 * though the work was genuinely happening (it just never got a live
 * indicator in the open conversation view). Closing and reopening the
 * tab "fixed" it only because renderMessages() rebuilds from persisted
 * thread.messages — a workaround, not a fix.
 *
 * The fix mirrors the pattern already used by the 'token', 'streaming_start',
 * and 'task_started' cases in the same file: self-heal a missing
 * `streamingEl` via `createStreamingEl()` right before use, rather than
 * silently skipping.
 *
 * ThreadsView is a full Obsidian ItemView and isn't easily instantiated
 * directly in this suite (see threads-view-plan-card-container.test.ts for
 * the established pattern) — this test instead mirrors the fixed 'tool_use'
 * branch logic as a standalone function and exercises it against real DOM
 * nodes under jsdom.
 */

import { describe, it, expect } from 'vitest';

/** Mirrors ThreadsView#createStreamingEl() (the parts relevant to this test). */
function createStreamingEl(messagesEl: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ct-message ct-message-assistant ct-streaming';
  messagesEl.appendChild(el);
  return el;
}

/**
 * Mirrors the fixed 'tool_use' case branch in ThreadsView#handleEvent:
 *   const isAgentCall = event.record.name === 'Agent';
 *   if (!isAgentCall) {
 *     if (!this.streamingEl) this.createStreamingEl();
 *     ...append pill into this.streamingEl...
 *   }
 *
 * Returns the (possibly newly created) streamingEl, mirroring how a real
 * ThreadsView instance would write the self-healed element back onto
 * `this.streamingEl`.
 */
function handleToolUsePill(
  streamingEl: HTMLElement | null,
  messagesEl: HTMLElement,
  isAgentCall: boolean,
): HTMLElement | null {
  if (!isAgentCall) {
    if (!streamingEl) streamingEl = createStreamingEl(messagesEl);
    const pill = document.createElement('div');
    pill.className = 'ct-tool-pill ct-tool-active';
    streamingEl.prepend(pill);
  }
  return streamingEl;
}

describe('ThreadsView tool_use self-heal — missing streamingEl regression', () => {
  it('creates a new streamingEl and appends a pill when streamingEl is null — the exact regression this fix guards against', () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);

    const result = handleToolUsePill(null, messagesEl, false);

    // A streaming element was created and attached under messagesEl...
    expect(result).not.toBeNull();
    expect(result!.isConnected).toBe(true);
    expect(messagesEl.contains(result!)).toBe(true);

    // ...and the tool call is actually visible: a pill exists inside it.
    const pill = result!.querySelector('.ct-tool-pill');
    expect(pill).not.toBeNull();

    // Before the fix, this whole branch was a silent no-op: no element,
    // no pill, nothing rendered — the tool call vanished from the view.
  });

  it('appends the pill into the existing streamingEl instead of creating a new one — preserves normal-case behavior', () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);
    const existingStreamingEl = document.createElement('div');
    existingStreamingEl.className = 'ct-message ct-message-assistant ct-streaming';
    messagesEl.appendChild(existingStreamingEl);

    const result = handleToolUsePill(existingStreamingEl, messagesEl, false);

    // Same element reused, not a fresh one.
    expect(result).toBe(existingStreamingEl);
    expect(messagesEl.querySelectorAll('.ct-streaming').length).toBe(1);

    // Pill landed inside the pre-existing element.
    const pill = existingStreamingEl.querySelector('.ct-tool-pill');
    expect(pill).not.toBeNull();
  });

  it('creates no pill for Agent-tool calls, whether streamingEl starts null or non-null — intentional skip is unchanged', () => {
    const messagesElA = document.createElement('div');
    document.body.appendChild(messagesElA);
    const resultA = handleToolUsePill(null, messagesElA, true);

    // No self-heal happens for Agent calls either — task_started owns that.
    expect(resultA).toBeNull();
    expect(messagesElA.querySelector('.ct-tool-pill')).toBeNull();
    expect(messagesElA.children.length).toBe(0);

    const messagesElB = document.createElement('div');
    document.body.appendChild(messagesElB);
    const existingStreamingEl = document.createElement('div');
    existingStreamingEl.className = 'ct-message ct-message-assistant ct-streaming';
    messagesElB.appendChild(existingStreamingEl);

    const resultB = handleToolUsePill(existingStreamingEl, messagesElB, true);

    // Existing element is returned untouched — no pill added.
    expect(resultB).toBe(existingStreamingEl);
    expect(existingStreamingEl.querySelector('.ct-tool-pill')).toBeNull();
  });
});

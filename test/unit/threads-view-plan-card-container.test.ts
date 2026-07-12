/**
 * @vitest-environment jsdom
 *
 * Regression test for the "ExitPlanMode hangs forever" bug (fix/stream-closed-
 * permission-channel): renderPlanCard (and every other inline card renderer —
 * permission, question, elicitation, context usage, tool-result images) used
 * `this.streamingEl ?? this.messagesEl` as its anchor. `streamingEl` is only
 * ever null-checked, not connectivity-checked, so when `plan_ready` fires
 * *after* the assistant message that triggered it has already finalized (and
 * `streamingEl`'s node removed from the DOM, but the field not yet nulled),
 * the card silently rendered into a detached node and never became visible —
 * the session was correctly blocked waiting on the approve/reject callback,
 * but nothing on screen showed it.
 *
 * ThreadsView.cardContainer() fixes this by additionally checking
 * `streamingEl.isConnected`. ThreadsView itself is a full Obsidian ItemView
 * and isn't instantiated directly in this suite (see
 * threads-view-cancel-restore.test.ts for the established pattern) — this
 * test instead exercises a direct mirror of cardContainer() against real DOM
 * nodes under jsdom, so `isConnected` reflects genuine attach/detach
 * semantics rather than a hand-set flag.
 */

import { describe, it, expect } from 'vitest';

/** Mirrors ThreadsView#cardContainer() exactly. */
function cardContainer(streamingEl: HTMLElement | null, messagesEl: HTMLElement): HTMLElement {
  return streamingEl?.isConnected ? streamingEl : messagesEl;
}

describe('ThreadsView cardContainer — detached streamingEl regression', () => {
  it('anchors to streamingEl when it is attached to the DOM', () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);
    const streamingEl = document.createElement('div');
    messagesEl.appendChild(streamingEl);

    expect(cardContainer(streamingEl, messagesEl)).toBe(streamingEl);
  });

  it('falls back to messagesEl when streamingEl is null', () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);

    expect(cardContainer(null, messagesEl)).toBe(messagesEl);
  });

  it('falls back to messagesEl when streamingEl is non-null but detached — the plan_ready-after-finalize case', () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);
    const streamingEl = document.createElement('div');
    messagesEl.appendChild(streamingEl);

    // Simulate the turn finalizing (the assistant message renders and the
    // streaming bubble is removed) before the field itself is nulled —
    // exactly the race that produced the invisible plan card.
    streamingEl.remove();
    expect(streamingEl.isConnected).toBe(false);

    expect(cardContainer(streamingEl, messagesEl)).toBe(messagesEl);
  });

  it('a card built via cardContainer is actually visible (attached to document) in the detached-streamingEl case', () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);
    const streamingEl = document.createElement('div');
    messagesEl.appendChild(streamingEl);
    streamingEl.remove();

    const container = cardContainer(streamingEl, messagesEl);
    const card = document.createElement('div');
    card.className = 'ct-plan-card';
    container.appendChild(card);

    expect(card.isConnected).toBe(true);
    expect(document.querySelector('.ct-plan-card')).toBe(card);
  });
});

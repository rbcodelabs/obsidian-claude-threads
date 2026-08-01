/**
 * @vitest-environment jsdom
 *
 * Regression test for "plan/question card renders above history instead of
 * at the bottom" (fix/plan-card-render-order): setActiveThread() called the
 * async renderMessages() without `await`, then immediately called
 * restorePendingPlanCard()/restorePendingQuestionCard() synchronously right
 * after it. Because renderMessages() awaits per-message markdown rendering
 * in a loop, calling it without `await` only runs it synchronously up to
 * its first `await` before control returns to the caller — the very next
 * line (restorePendingPlanCard) then ran while the rest of history was
 * still mid-append, splicing the card in partway through the timeline
 * instead of after the last message.
 *
 * ThreadsView is a full Obsidian ItemView and isn't instantiated directly in
 * this suite (see threads-view-cancel-restore.test.ts / this project's other
 * ThreadsView tests for the established pattern) — this test instead
 * exercises a pure-logic mirror of the two functions against real DOM nodes
 * under jsdom, with a genuine `await Promise.resolve()` yield per rendered
 * message so the interleaving is real, not simulated.
 */

import { describe, it, expect } from 'vitest';

/** Mirrors ThreadsView#renderMessages(): appends one div per message, with a real async yield per message (the markdown-render await in the real code). */
async function renderMessages(messagesEl: HTMLElement, messages: string[]): Promise<void> {
  messagesEl.innerHTML = '';
  for (const msg of messages) {
    await Promise.resolve(); // mirrors `await this.renderMarkdown(...)`
    const el = document.createElement('div');
    el.className = 'ct-message';
    el.textContent = msg;
    messagesEl.appendChild(el);
  }
}

/** Mirrors ThreadsView#restorePendingPlanCard(): synchronously appends the plan card to messagesEl. */
function restorePendingPlanCard(messagesEl: HTMLElement): void {
  const card = document.createElement('div');
  card.className = 'ct-plan-card';
  messagesEl.appendChild(card);
}

/** Mirrors the buggy setActiveThread(): fires renderMessages() without awaiting it. */
function setActiveThreadBuggy(messagesEl: HTMLElement, messages: string[]): void {
  void renderMessages(messagesEl, messages); // BUG: not awaited
  restorePendingPlanCard(messagesEl); // races the still-in-flight render loop
}

/** Mirrors the fixed setActiveThread(): awaits renderMessages() before restoring the card. */
async function setActiveThreadFixed(messagesEl: HTMLElement, messages: string[]): Promise<void> {
  await renderMessages(messagesEl, messages);
  restorePendingPlanCard(messagesEl);
}

describe('ThreadsView setActiveThread — plan card render order regression', () => {
  it('reproduces the bug: an un-awaited renderMessages() lets the plan card land mid-timeline', async () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);

    setActiveThreadBuggy(messagesEl, ['msg1', 'msg2', 'msg3']);
    // Let the un-awaited renderMessages() loop finish draining its microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const children = Array.from(messagesEl.children).map((c) => c.className);
    const cardIndex = children.indexOf('ct-plan-card');
    expect(cardIndex).toBeGreaterThan(-1);
    // The bug: the card is NOT last — at least one message renders after it.
    expect(cardIndex).toBeLessThan(children.length - 1);
  });

  it('fix: awaiting renderMessages() before restoring the card always places it last', async () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);

    await setActiveThreadFixed(messagesEl, ['msg1', 'msg2', 'msg3']);

    const children = Array.from(messagesEl.children).map((c) => c.className);
    expect(children).toEqual(['ct-message', 'ct-message', 'ct-message', 'ct-plan-card']);
  });
});

import { describe, it, expect } from 'vitest';

/**
 * Unit tests for the empty-content guard around the "Copy response" button in
 * ThreadsView.appendMessage() (desktop) and the equivalent guard in
 * MobileView.renderMessage() (see MobileView.test.ts — "copy button
 * empty-content guard" — for the DOM-level version of this test, since
 * MobileView is instantiated directly there).
 *
 * ThreadsView itself is a full Obsidian ItemView and isn't instantiated
 * directly in this suite (see threads-view-cancel-restore.test.ts for the
 * established pattern). Instead this mirrors the decision the real code
 * makes at the copy-button creation site in appendMessage():
 *
 *   if (msg.content && msg.content.trim().length > 0) { create copyBtn }
 *
 * Root cause this guards against: on a pure tool-call turn (e.g. TaskCreate,
 * ToolSearch with no accompanying assistant prose), msg.content is empty. On
 * mobile the copy button was always rendered regardless, producing a stray
 * icon-only row between the tool-call pill and the message footer/timestamp.
 * Desktop has the identical button but it's invisible by default (opacity: 0,
 * revealed on hover), so the same bug was latent there — this guard was added
 * for correctness/consistency so it can't resurface if that hover-hide CSS
 * ever changes.
 */
function shouldRenderCopyButton(content: string): boolean {
  return !!(content && content.trim().length > 0);
}

describe('ThreadsView / MobileView — copy button empty-content guard', () => {
  it('does not render the copy button for empty content (pure tool-call turn)', () => {
    expect(shouldRenderCopyButton('')).toBe(false);
  });

  it('does not render the copy button for whitespace-only content', () => {
    expect(shouldRenderCopyButton('   \n\t  ')).toBe(false);
  });

  it('renders the copy button for normal assistant text content', () => {
    expect(shouldRenderCopyButton('Here is the answer.')).toBe(true);
  });

  it('renders the copy button for content that is only whitespace-padded text', () => {
    expect(shouldRenderCopyButton('  Here is the answer.  ')).toBe(true);
  });
});

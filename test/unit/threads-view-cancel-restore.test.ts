import { describe, it, expect } from 'vitest';

/**
 * Unit tests for the cancel-and-restore behaviour introduced in ThreadsView.
 *
 * Three related pieces of logic are tested:
 *
 *   1. Save-on-send: the raw typed text is captured into `lastSentText`
 *      before the input box is cleared, so it can be restored later.
 *
 *   2. Restore-on-interrupt: when the session is interrupted (e.g. user
 *      clicks stop or presses Escape), `lastSentText` is written back into
 *      `inputEl.value` and then cleared so it doesn't leak into future stops.
 *
 *   3. Escape-key guard: the Escape key must only trigger a stop when the
 *      stop button is actually visible (i.e. a session is running). When
 *      nothing is running the key should be a no-op for this handler.
 *
 * All three are tested against pure logic mirrors that avoid Obsidian DOM
 * dependencies — the same pattern used elsewhere in this test suite.
 */

// ---------------------------------------------------------------------------
// State model mirroring the relevant fields in ThreadsView
// ---------------------------------------------------------------------------

interface InputState {
  value: string;
}

interface CancelRestoreState {
  lastSentText: string;
  inputEl: InputState;
  stopBtnVisible: boolean;
}

function makeState(): CancelRestoreState {
  return {
    lastSentText: '',
    inputEl: { value: '' },
    stopBtnVisible: false,
  };
}

// ---------------------------------------------------------------------------
// Pure-logic mirrors of the three ThreadsView code paths
// ---------------------------------------------------------------------------

/** Mirrors the save-on-send path in sendMessage(). */
function onSend(state: CancelRestoreState, typed: string): void {
  state.lastSentText = typed;
  state.inputEl.value = '';
  state.stopBtnVisible = true;          // setRunningState(true) makes stop visible
}

/** Mirrors the restore-on-interrupt path in the 'interrupted' event case. */
function onInterrupted(state: CancelRestoreState): void {
  if (state.lastSentText) {
    state.inputEl.value = state.lastSentText;
    state.lastSentText = '';
  }
  state.stopBtnVisible = false;         // setRunningState(false) hides stop button
}

/** Mirrors the completed-successfully path (no restore should happen). */
function onCompleted(state: CancelRestoreState): void {
  state.stopBtnVisible = false;
}

/**
 * Mirrors the Escape-key guard in the keydown handler:
 *   if (e.key === 'Escape' && !this.stopBtn.hasClass('ct-hidden')) { stop }
 *
 * Returns true when the key press should trigger a stop.
 */
function shouldEscapeStop(key: string, stopBtnVisible: boolean): boolean {
  return key === 'Escape' && stopBtnVisible;
}

// ---------------------------------------------------------------------------
// Tests: save-on-send
// ---------------------------------------------------------------------------

describe('ThreadsView cancel-restore — save on send', () => {
  it('captures typed text into lastSentText before clearing the input', () => {
    const state = makeState();
    onSend(state, 'fix the login bug');
    expect(state.lastSentText).toBe('fix the login bug');
  });

  it('clears the input box after saving lastSentText', () => {
    const state = makeState();
    state.inputEl.value = 'some draft text';
    onSend(state, 'some draft text');
    expect(state.inputEl.value).toBe('');
  });

  it('captures an empty string when sent with no text', () => {
    const state = makeState();
    onSend(state, '');
    expect(state.lastSentText).toBe('');
  });

  it('overwrites any previous lastSentText on a new send', () => {
    const state = makeState();
    onSend(state, 'first message');
    onCompleted(state);
    onSend(state, 'second message');
    expect(state.lastSentText).toBe('second message');
  });
});

// ---------------------------------------------------------------------------
// Tests: restore-on-interrupt
// ---------------------------------------------------------------------------

describe('ThreadsView cancel-restore — restore on interrupt', () => {
  it('restores the sent message to the input box on interrupt', () => {
    const state = makeState();
    onSend(state, 'refactor the auth module');
    onInterrupted(state);
    expect(state.inputEl.value).toBe('refactor the auth module');
  });

  it('clears lastSentText after restoring so it does not leak into future stops', () => {
    const state = makeState();
    onSend(state, 'some message');
    onInterrupted(state);
    expect(state.lastSentText).toBe('');
  });

  it('does not overwrite a user-typed draft if lastSentText is empty', () => {
    const state = makeState();
    state.inputEl.value = 'new draft the user typed';
    onInterrupted(state);                      // nothing was sent — lastSentText is ''
    expect(state.inputEl.value).toBe('new draft the user typed');
  });

  it('a second stop after restore does not re-inject anything', () => {
    const state = makeState();
    onSend(state, 'first send');
    onInterrupted(state);                      // restores 'first send' and clears lastSentText
    state.inputEl.value = '';                  // user cleared the box
    onInterrupted(state);                      // second stop — nothing to restore
    expect(state.inputEl.value).toBe('');
  });

  it('does not restore on a successful completion', () => {
    const state = makeState();
    onSend(state, 'run the tests');
    onCompleted(state);                        // session finished normally — no restore
    // lastSentText is still set (it's only cleared on interrupted)
    // but the input box stays empty — restore is NOT called on completion
    expect(state.inputEl.value).toBe('');
  });

  it('preserves the full multiline text including trailing newlines', () => {
    const multiline = 'line one\nline two\nline three';
    const state = makeState();
    onSend(state, multiline);
    onInterrupted(state);
    expect(state.inputEl.value).toBe(multiline);
  });
});

// ---------------------------------------------------------------------------
// Tests: Escape-key guard
// ---------------------------------------------------------------------------

describe('ThreadsView cancel-restore — Escape key guard', () => {
  it('Escape triggers stop when the stop button is visible (session running)', () => {
    expect(shouldEscapeStop('Escape', true)).toBe(true);
  });

  it('Escape is a no-op when the stop button is hidden (nothing running)', () => {
    expect(shouldEscapeStop('Escape', false)).toBe(false);
  });

  it('other keys do not trigger stop even when the session is running', () => {
    expect(shouldEscapeStop('Enter', true)).toBe(false);
    expect(shouldEscapeStop('ArrowUp', true)).toBe(false);
    expect(shouldEscapeStop('a', true)).toBe(false);
  });

  it('Escape after session completes is a no-op (stop button is hidden)', () => {
    const state = makeState();
    onSend(state, 'something');
    onCompleted(state);                        // stop button hidden
    expect(shouldEscapeStop('Escape', state.stopBtnVisible)).toBe(false);
  });

  it('Escape while session is running triggers stop', () => {
    const state = makeState();
    onSend(state, 'something');               // stop button becomes visible
    expect(shouldEscapeStop('Escape', state.stopBtnVisible)).toBe(true);
  });
});

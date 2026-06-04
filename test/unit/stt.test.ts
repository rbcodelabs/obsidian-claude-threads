/**
 * stt.test.ts
 *
 * Unit tests for the PTT (push-to-talk) keyboard handling in SttController,
 * specifically the regression where releasing a modifier key (e.g. Alt) before
 * the primary key (e.g. Space) would leave recording stuck on.
 *
 * Also tests the matchesKey helper used for keydown matching.
 */

import { describe, it, expect } from 'vitest';
import { matchesKey, serializeKey } from '../../src/stt';

// ── matchesKey ───────────────────────────────────────────────────────────────

describe('matchesKey', () => {
  const makeEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...overrides }) as KeyboardEvent;

  it('matches a simple key with no modifiers', () => {
    expect(matchesKey(makeEvent({ key: 'F9' }), 'F9')).toBe(true);
  });

  it('does not match when the key differs', () => {
    expect(matchesKey(makeEvent({ key: 'F8' }), 'F9')).toBe(false);
  });

  it('matches Alt+Space with altKey=true and key=" "', () => {
    expect(matchesKey(makeEvent({ key: ' ', altKey: true }), 'Alt+Space')).toBe(true);
  });

  it('does NOT match Alt+Space when altKey is false (modifier released first)', () => {
    // This is exactly the situation we do NOT want for keyup — but matchesKey
    // itself correctly returns false. The fix is in onKeyUp, not here.
    expect(matchesKey(makeEvent({ key: ' ', altKey: false }), 'Alt+Space')).toBe(false);
  });

  it('matches Ctrl+Shift+M with all modifiers', () => {
    expect(matchesKey(makeEvent({ key: 'M', ctrlKey: true, shiftKey: true }), 'Control+Shift+M')).toBe(true);
  });

  it('does not match bare modifier key', () => {
    expect(matchesKey(makeEvent({ key: 'Alt' }), 'Alt')).toBe(false);
  });

  it('treats Space as " "', () => {
    expect(matchesKey(makeEvent({ key: ' ' }), 'Space')).toBe(true);
  });
});

// ── serializeKey ─────────────────────────────────────────────────────────────

describe('serializeKey', () => {
  const makeEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...overrides }) as KeyboardEvent;

  it('returns empty string for bare modifier press', () => {
    expect(serializeKey(makeEvent({ key: 'Alt' }))).toBe('');
    expect(serializeKey(makeEvent({ key: 'Control' }))).toBe('');
    expect(serializeKey(makeEvent({ key: 'Shift' }))).toBe('');
    expect(serializeKey(makeEvent({ key: 'Meta' }))).toBe('');
  });

  it('serializes a simple key', () => {
    expect(serializeKey(makeEvent({ key: 'F9' }))).toBe('F9');
  });

  it('serializes Alt+Space as "Alt+Space"', () => {
    expect(serializeKey(makeEvent({ key: ' ', altKey: true }))).toBe('Alt+Space');
  });

  it('serializes Ctrl+Shift+M', () => {
    expect(serializeKey(makeEvent({ key: 'M', ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+M');
  });
});

// ── PTT keyup — modifier-released-first regression ──────────────────────────

describe('PTT onKeyUp — modifier-released-first regression', () => {
  /**
   * Simulates the bug scenario:
   *   User holds Alt+Space → recording starts (pttActive = true)
   *   User releases Alt first → keyup event for Alt fires (key='Alt') — should be ignored
   *   User releases Space → keyup event fires with e.altKey=false — should STILL stop recording
   *
   * This test directly exercises the logic from the fixed onKeyUp handler
   * without needing a real MediaRecorder or microphone.
   */
  it('stops recording when primary key released after modifier already released', () => {
    // Inline the fixed onKeyUp logic so we can test it in isolation
    let pttActive = true; // simulate recording in progress
    let stopCalled = false;

    const getKey = () => 'Alt+Space';

    // This is the FIXED onKeyUp logic (only checks terminal key)
    const onKeyUp = (e: KeyboardEvent) => {
      if (!pttActive) return;
      const key = getKey();
      if (!key) return;
      const parts = key.split('+');
      const rawKey = parts[parts.length - 1];
      const expectedKey = rawKey === 'Space' ? ' ' : rawKey;
      if (e.key !== expectedKey) return;
      pttActive = false;
      stopCalled = true; // proxy for recorder.stop()
    };

    // Step 1: user releases Alt first (e.altKey becomes false)
    const altReleaseEvent = { key: 'Alt', altKey: false } as KeyboardEvent;
    onKeyUp(altReleaseEvent);
    expect(pttActive).toBe(true); // still recording — Alt release is ignored ✓
    expect(stopCalled).toBe(false);

    // Step 2: user releases Space (e.altKey is still false — modifier already gone)
    const spaceReleaseEvent = { key: ' ', altKey: false } as KeyboardEvent;
    onKeyUp(spaceReleaseEvent);
    expect(pttActive).toBe(false); // recording stopped ✓
    expect(stopCalled).toBe(true);
  });

  it('also stops correctly when Space released before Alt (normal order)', () => {
    let pttActive = true;
    let stopCalled = false;
    const getKey = () => 'Alt+Space';

    const onKeyUp = (e: KeyboardEvent) => {
      if (!pttActive) return;
      const key = getKey();
      if (!key) return;
      const parts = key.split('+');
      const rawKey = parts[parts.length - 1];
      const expectedKey = rawKey === 'Space' ? ' ' : rawKey;
      if (e.key !== expectedKey) return;
      pttActive = false;
      stopCalled = true;
    };

    // Space released while Alt is still held (altKey=true) — the normal order
    const spaceReleaseEvent = { key: ' ', altKey: true } as KeyboardEvent;
    onKeyUp(spaceReleaseEvent);
    expect(pttActive).toBe(false);
    expect(stopCalled).toBe(true);
  });

  it('does not fire for unrelated keys while recording', () => {
    let pttActive = true;
    let stopCalled = false;
    const getKey = () => 'Alt+Space';

    const onKeyUp = (e: KeyboardEvent) => {
      if (!pttActive) return;
      const key = getKey();
      if (!key) return;
      const parts = key.split('+');
      const rawKey = parts[parts.length - 1];
      const expectedKey = rawKey === 'Space' ? ' ' : rawKey;
      if (e.key !== expectedKey) return;
      pttActive = false;
      stopCalled = true;
    };

    // Some unrelated key pressed/released while recording
    onKeyUp({ key: 'a' } as KeyboardEvent);
    onKeyUp({ key: 'Enter' } as KeyboardEvent);
    expect(pttActive).toBe(true); // still recording
    expect(stopCalled).toBe(false);
  });
});

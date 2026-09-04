/**
 * confirm-modal.test.ts
 * @vitest-environment jsdom
 */
import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom
import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import { ConfirmModal, promptConfirm } from '../../src/confirmModal';

/**
 * Regression guard for the dismissal bug this module was extracted to fix.
 *
 * The original ConfirmModal (in SkillsManagerView) resolved `onResult` inside
 * the two button handlers and did nothing in `onClose`, so Esc / click-outside
 * never called back at all — and `ThreadsView.closeThread`, which awaits a
 * Promise around it, hung forever. The fix resolves in `onClose` ONLY.
 */

/**
 * Real Obsidian's `Modal.close()` calls `onClose()`; the vitest obsidian mock's
 * is a no-op. Wire it up per instance so these tests exercise the real
 * lifecycle — that ordering is the whole point of the fix.
 */
function open(message: string, label: string, onResult: (confirmed: boolean) => void): ConfirmModal {
  const modal = new ConfirmModal(new App() as never, message, label, onResult);
  modal.close = () => modal.onClose();
  modal.onOpen();
  return modal;
}

function button(modal: ConfirmModal, text: string): HTMLButtonElement {
  const el = [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === text);
  if (!el) throw new Error(`No "${text}" button. Found: ${[...modal.contentEl.querySelectorAll('button')].map(b => b.textContent).join(', ')}`);
  return el as HTMLButtonElement;
}

describe('ConfirmModal', () => {
  it('renders the message and the caller’s confirm label', () => {
    const modal = open('Archive 3 runs?', 'Archive anyway', vi.fn());
    expect(modal.contentEl.querySelector('p')?.textContent).toBe('Archive 3 runs?');
    expect(button(modal, 'Archive anyway')).toBeTruthy();
    expect(button(modal, 'Cancel')).toBeTruthy();
  });

  it('resolves false when dismissed with Esc or a click outside (no button pressed)', () => {
    const onResult = vi.fn();
    const modal = open('msg', 'Archive', onResult);

    // Obsidian calls onClose() directly on Esc / click-outside — no button ran.
    modal.onClose();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(false);
  });

  it('resolves true exactly once from the confirm button, despite close() also firing onClose', () => {
    const onResult = vi.fn();
    const modal = open('msg', 'Archive anyway', onResult);

    button(modal, 'Archive anyway').click();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(true);
    // Never `false` first — the bug that resolving in BOTH places would cause.
    expect(onResult.mock.calls[0][0]).toBe(true);
  });

  it('resolves false exactly once from the Cancel button', () => {
    const onResult = vi.fn();
    const modal = open('msg', 'Archive', onResult);

    button(modal, 'Cancel').click();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(false);
  });

  it('does not re-fire if onClose runs a second time', () => {
    const onResult = vi.fn();
    const modal = open('msg', 'Archive anyway', onResult);

    button(modal, 'Archive anyway').click();
    modal.onClose();
    modal.onClose();

    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('empties contentEl on close', () => {
    const modal = open('msg', 'Archive', vi.fn());
    expect(modal.contentEl.childElementCount).toBeGreaterThan(0);
    modal.onClose();
    expect(modal.contentEl.childElementCount).toBe(0);
  });
});

describe('promptConfirm', () => {
  it('settles instead of hanging when the dialog is dismissed', async () => {
    // Drive the same lifecycle promptConfirm relies on: the mock's open() is a
    // no-op, so stand in for it by calling onOpen/onClose on the instance.
    const opened: ConfirmModal[] = [];
    const realOpen = ConfirmModal.prototype.open;
    ConfirmModal.prototype.open = function (this: ConfirmModal) { opened.push(this); this.onOpen(); };
    try {
      const promise = promptConfirm(new App() as never, { message: 'msg', confirmLabel: 'Archive' });
      opened[0].onClose();
      await expect(promise).resolves.toBe(false);
    } finally {
      ConfirmModal.prototype.open = realOpen;
    }
  });

  it('resolves true when the confirm button is pressed', async () => {
    const opened: ConfirmModal[] = [];
    const realOpen = ConfirmModal.prototype.open;
    ConfirmModal.prototype.open = function (this: ConfirmModal) {
      opened.push(this);
      this.close = () => this.onClose();
      this.onOpen();
    };
    try {
      const promise = promptConfirm(new App() as never, { message: 'msg', confirmLabel: 'Archive anyway' });
      button(opened[0], 'Archive anyway').click();
      await expect(promise).resolves.toBe(true);
    } finally {
      ConfirmModal.prototype.open = realOpen;
    }
  });
});

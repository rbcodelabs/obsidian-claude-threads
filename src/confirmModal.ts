import { App, Modal } from 'obsidian';

/**
 * Yes/no confirmation dialog. Lived in SkillsManagerView.ts until the archive
 * context menu needed it too; moved here so a leaf module can depend on it
 * without pulling in the whole skills manager.
 *
 * The move also fixes a latent bug. The original resolved `onResult` inside the
 * two button handlers and did nothing in `onClose`, so dismissing the dialog
 * with Esc or a click outside never called back at all — and
 * `ThreadsView.closeThread`, which wraps this in `new Promise`, hung forever.
 *
 * The fix resolves in `onClose` **only**. Resolving in the button handlers too
 * would be worse than the bug: they call `close()` first, so `onClose` would
 * deliver `false` before the handler delivered `true`.
 */
export class ConfirmModal extends Modal {
  private onResult: (confirmed: boolean) => void;
  private message: string;
  private confirmLabel: string;
  /** Set by the confirm button before it closes; read once by `onClose`. */
  private result = false;
  /** Guards against a second `onClose` (Obsidian may call it more than once). */
  private resolved = false;

  constructor(
    app: App,
    message: string,
    confirmLabel: string,
    onResult: (confirmed: boolean) => void,
  ) {
    super(app);
    this.message = message;
    this.confirmLabel = confirmLabel;
    this.onResult = onResult;
  }

  onOpen(): void {
    this.contentEl.createEl('p', { text: this.message });
    const btns = this.contentEl.createEl('div', { cls: 'ct-skills-modal-btns' });
    btns.createEl('button', { cls: 'ct-skills-btn', text: 'Cancel' }).addEventListener('click', () => {
      this.close();
    });
    btns.createEl('button', { cls: 'ct-skills-btn ct-skills-btn--danger', text: this.confirmLabel }).addEventListener('click', () => {
      this.result = true;
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolved) return;
    this.resolved = true;
    this.onResult(this.result);
  }
}

/**
 * Promise wrapper around ConfirmModal. Safe to `await` because dismissal now
 * resolves `false` rather than leaving the promise pending.
 */
export function promptConfirm(
  app: App,
  confirm: { message: string; confirmLabel: string },
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    new ConfirmModal(app, confirm.message, confirm.confirmLabel, resolve).open();
  });
}

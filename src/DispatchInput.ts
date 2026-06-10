import { App, setIcon, setTooltip, Notice } from 'obsidian';
import type { ImageAttachment, ImageMediaType } from './types';
import { MAX_ATTACHMENT_BYTES } from './attachmentUtils';
import { SttController } from './stt';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface DispatchPayload {
  text: string;
  images: ImageAttachment[];
  attachment: string | null;
}

export interface DispatchInputOptions {
  app: App;
  placeholder?: string;
  /** Built-in slash commands to show before skill completions */
  builtinCommands?: { name: string; description: string }[];
  /**
   * Argument completions per command name. When the input starts with
   * "/<command> " and the cursor is in the first argument word, the matching
   * options are offered in the same dropdown (e.g. /model → fable|opus|...).
   */
  argCompletions?: Record<string, { name: string; description: string }[]>;
  /** Called with the raw payload after the user submits */
  onSend: (payload: DispatchPayload) => Promise<void> | void;

  // ── New optional features ──────────────────────────────────────────────────
  /** Show a stop (■) button alongside send; toggle via setStreaming() */
  showStopBtn?: boolean;
  /** Called when the stop button is clicked or Escape is pressed while streaming */
  onStop?: () => void;
  /** Include "@this (currently open file)" as the first option in the file dropdown */
  showThisMention?: boolean;
  /** Show a CWD folder chip in the footer row; updated via setCwd() */
  showCwdChip?: boolean;
  /** Called when the CWD chip is clicked */
  onCwdClick?: (e: MouseEvent) => void;
  /** Intercept pastes ≥500 chars as an attachment chip instead of inline text */
  captureLongPaste?: boolean;
  /** Called on every textarea keystroke */
  onInput?: () => void;
  /** Called when a chip is added or removed */
  onChipChange?: () => void;
  /** Slot for the caller to inject extra buttons into the footer actions area */
  appendFooterActions?: (container: HTMLElement) => void;
  /**
   * When true, renders a compact single-row layout suitable for wider panels:
   *   [attach · mic]  [textarea (auto-grow)]  [send/stop]
   * No footer row is rendered in this mode.
   */
  inlineLayout?: boolean;
  /** Override the textarea CSS class (default: 'ct-agents-dispatch-input') */
  inputCls?: string;
  /** Minimum text length to allow sending when no attachment/images (default: 0) */
  minTextLength?: number;
  /** Text/symbol for the send button (default: '▶') */
  sendBtnText?: string;
  /** Title tooltip for the send button (default: 'Start task') */
  sendBtnTitle?: string;
  /**
   * Called on every keydown/keyup to retrieve the current push-to-talk hotkey
   * string (e.g. "Alt+Space"). When provided, hold-to-record PTT is enabled.
   * Reading from settings on each event means hotkey changes take effect
   * immediately without re-mounting the component.
   */
  getPttKey?: () => string;
}

export class DispatchInput {
  private app: App;
  private options: DispatchInputOptions;

  private rootEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private inputRow!: HTMLElement;
  private pasteChipsEl!: HTMLElement;
  private hiddenFileInput!: HTMLInputElement;

  private sendBtn!: HTMLButtonElement;
  private stopBtn: HTMLButtonElement | null = null;
  private cwdChipNameEl: HTMLElement | null = null;
  private cwdChipEl: HTMLElement | null = null;

  private pendingImages: ImageAttachment[] = [];
  private pendingAttachment: string | null = null;

  // @mention dropdown
  private fileDropdown: HTMLElement | null = null;
  private fileDropdownItems: { path: string; basename: string; isThis?: boolean }[] = [];
  private fileDropdownIndex = 0;

  // /slash dropdown
  private skills: { name: string; description: string }[] = [];
  private skillDropdown: HTMLElement | null = null;
  private skillDropdownItems: { name: string; description: string }[] = [];
  private skillDropdownIndex = 0;
  // 'command' completes the /command word itself; 'arg' completes its first argument
  private skillDropdownMode: 'command' | 'arg' = 'command';

  private sttController: SttController | null = null;
  private dispatching = false;

  constructor(options: DispatchInputOptions) {
    this.app = options.app;
    this.options = options;
    this.loadSkills();
  }

  /**
   * Build the dispatch UI inside `parent` and return the root element.
   * The root element has class `ct-dispatch-root`.
   */
  mount(parent: HTMLElement): HTMLElement {
    this.rootEl = parent.createDiv('ct-dispatch-root');

    // Paste chips strip — hidden until attachments are added
    this.pasteChipsEl = this.rootEl.createDiv('ct-paste-chips ct-dispatch-chips ct-hidden');

    // Input row: textarea + action buttons
    const isInline = !!this.options.inlineLayout;
    this.inputRow = this.rootEl.createDiv(isInline ? 'ct-dispatch-inline-row' : 'ct-agents-dispatch-row');

    // In inline mode, action buttons sit to the LEFT of the textarea (created first so they appear left)
    const leftActionsEl = isInline ? this.inputRow.createDiv('ct-dispatch-left-actions') : null;

    this.inputEl = this.inputRow.createEl('textarea', {
      cls: this.options.inputCls ?? 'ct-agents-dispatch-input',
      attr: {
        placeholder: this.options.placeholder ?? 'Dispatch a task',
        rows: '1',
      },
    });

    const inputActions = this.inputRow.createDiv('ct-input-actions');

    const sendBtn = inputActions.createEl('button', {
      cls: 'ct-send-btn ct-agents-dispatch-btn',
      text: this.options.sendBtnText ?? '▶',
      attr: { title: this.options.sendBtnTitle ?? 'Start task' },
    });
    sendBtn.addEventListener('click', () => this.send());
    this.sendBtn = sendBtn;

    // Optional stop button (shown/hidden via setStreaming())
    if (this.options.showStopBtn) {
      this.stopBtn = inputActions.createEl('button', {
        cls: 'ct-stop-btn ct-hidden',
        text: '■',
        attr: { title: 'Stop' },
      });
      this.stopBtn.addEventListener('click', () => this.options.onStop?.());
    }

    // Build attach button (appended into footer or inputActions below)
    const attachBtn = document.createElement('button');
    attachBtn.className = 'ct-more-btn ct-agents-dispatch-attach-btn';
    attachBtn.title = 'Attach file';
    setIcon(attachBtn, 'paperclip');

    // Hidden file picker triggered by attachBtn
    this.hiddenFileInput = document.createElement('input');
    this.hiddenFileInput.type = 'file';
    this.hiddenFileInput.accept = '*';
    this.hiddenFileInput.multiple = true;
    this.hiddenFileInput.style.display = 'none';
    this.hiddenFileInput.addEventListener('change', () => {
      for (const f of Array.from(this.hiddenFileInput.files ?? [])) {
        if (f.type.startsWith('image/')) {
          this.addImageAttachment(f);
        } else {
          this.addFileAsTextAttachment(f);
        }
      }
      this.hiddenFileInput.value = '';
    });
    this.inputRow.appendChild(this.hiddenFileInput);
    attachBtn.addEventListener('click', () => this.hiddenFileInput.click());

    // Mic button for speech-to-text
    this.sttController = new SttController(this.app);
    const micBtn = this.sttController.createMicButton(this.inputEl);
    if (this.options.getPttKey) {
      this.sttController.attachPttToTextarea(this.inputEl, this.options.getPttKey);
    }

    if (isInline) {
      // ── Inline layout: attach + mic sit LEFT of the textarea ─────────────
      this.cwdChipNameEl = null;
      this.cwdChipEl = null;
      leftActionsEl!.appendChild(attachBtn);
      leftActionsEl!.appendChild(micBtn);
    } else {
      // ── Column layout: footer row or fallback to input-actions column ────
      const needsFooter = !!(this.options.showCwdChip || this.options.appendFooterActions);
      if (needsFooter) {
        const inputFooter = this.rootEl.createDiv('ct-input-footer');

        if (this.options.showCwdChip) {
          const cwdChipEl = inputFooter.createDiv({ cls: 'ct-edited-file-chip ct-edited-files-cwd ct-footer-cwd' });
          const cwdIcon = cwdChipEl.createSpan('ct-edited-file-chip-icon');
          setIcon(cwdIcon, 'folder');
          this.cwdChipNameEl = cwdChipEl.createSpan({ cls: 'ct-edited-file-chip-name' });
          this.cwdChipEl = cwdChipEl;
          if (this.options.onCwdClick) {
            cwdChipEl.addEventListener('click', (e) => this.options.onCwdClick!(e));
          }
        } else {
          this.cwdChipNameEl = null;
          this.cwdChipEl = null;
        }

        const footerActionsEl = inputFooter.createDiv('ct-input-footer-actions');
        this.options.appendFooterActions?.(footerActionsEl);
        // Attach + mic live in the footer bottom row (keeps input area compact)
        footerActionsEl.appendChild(attachBtn);
        footerActionsEl.appendChild(micBtn);
      } else {
        this.cwdChipNameEl = null;
        this.cwdChipEl = null;
        // No footer — fall back to putting attach + mic in the input actions column
        inputActions.appendChild(attachBtn);
        inputActions.appendChild(micBtn);
      }
    }

    // Keyboard handlers
    this.inputEl.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.inputEl.addEventListener('input', () => this.onInput());
    this.inputEl.addEventListener('blur', () => {
      // Delay so mousedown on a dropdown item fires before blur hides it
      setTimeout(() => {
        this.hideFileDropdown();
        this.hideSkillDropdown();
      }, 150);
    });

    // Paste: capture image files and (optionally) long text from clipboard
    this.inputEl.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      const imageFiles = files.filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        e.preventDefault();
        imageFiles.forEach(f => this.addImageAttachment(f));
        return;
      }
      if (this.options.captureLongPaste) {
        const plainText = e.clipboardData?.getData('text/plain') ?? '';
        if (plainText.length >= 500) {
          e.preventDefault();
          this.setPendingAttachment(plainText);
          this.options.onChipChange?.();
          return;
        }
      }
    });

    // Drag-and-drop onto the root element
    this.rootEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.rootEl.addClass('ct-drag-over');
    });
    this.rootEl.addEventListener('dragleave', (e) => {
      if (!this.rootEl.contains(e.relatedTarget as Node | null)) {
        this.rootEl.removeClass('ct-drag-over');
      }
    });
    this.rootEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.rootEl.removeClass('ct-drag-over');
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          this.addImageAttachment(file);
        } else {
          this.addFileAsTextAttachment(file);
        }
      }
    });

    return this.rootEl;
  }

  focus(): void { this.inputEl?.focus(); }

  /** Resize the textarea to fit its content (used in inline layout). */
  private autoGrow(): void {
    if (!this.inputEl) return;
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
  }

  destroy(): void {
    this.sttController?.destroy();
    this.hideFileDropdown();
    this.hideSkillDropdown();
  }

  // ── Public getters / setters ──────────────────────────────────────────────

  getValue(): string { return this.inputEl?.value ?? ''; }

  setValue(v: string): void { if (this.inputEl) this.inputEl.value = v; }

  setStreaming(v: boolean): void {
    if (!this.options.showStopBtn) return;
    if (v) {
      this.sendBtn.addClass('ct-hidden');
      this.stopBtn?.removeClass('ct-hidden');
    } else {
      this.sendBtn.removeClass('ct-hidden');
      this.stopBtn?.addClass('ct-hidden');
      this.inputEl?.focus();
    }
  }

  setCwd(displayText: string, tooltip: string): void {
    if (!this.cwdChipNameEl || !this.cwdChipEl) return;
    this.cwdChipNameEl.textContent = displayText;
    setTooltip(this.cwdChipEl, tooltip);
  }

  getPendingAttachment(): string | null { return this.pendingAttachment; }

  setPendingAttachment(v: string | null): void {
    this.pendingAttachment = v;
    this.renderChips();
  }

  getPendingImages(): ImageAttachment[] { return this.pendingImages.slice(); }

  setPendingImages(imgs: ImageAttachment[]): void {
    this.pendingImages = [...imgs];
    this.renderChips();
  }

  clearAttachments(): void {
    this.pendingAttachment = null;
    this.pendingImages = [];
    this.renderChips();
  }

  triggerSend(): void { this.send(); }

  // ── Send ─────────────────────────────────────────────────────────────────

  private async send(): Promise<void> {
    if (this.dispatching) return;
    const text = this.inputEl.value.trim();
    const attachment = this.pendingAttachment;
    const images = this.pendingImages.slice();
    if (!text && !attachment && images.length === 0) return;

    this.dispatching = true;
    this.inputEl.value = '';
    this.autoGrow();
    this.pendingAttachment = null;
    this.pendingImages = [];
    this.renderChips();

    try {
      await this.options.onSend({ text, images, attachment });
    } finally {
      this.dispatching = false;
    }
  }

  // ── Attachment handling ───────────────────────────────────────────────────

  private addImageAttachment(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      this.pendingImages.push({
        base64,
        mediaType: file.type as ImageMediaType,
        name: file.name || 'image',
      });
      this.renderChips();
      this.options.onChipChange?.();
    };
    reader.readAsDataURL(file);
  }

  private addFileAsTextAttachment(file: File): void {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      new Notice(`"${file.name}" is too large to attach (max 500 KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.pendingAttachment = `${file.name}\n${reader.result as string}`;
      this.renderChips();
      this.options.onChipChange?.();
    };
    reader.onerror = () => new Notice(`Could not read "${file.name}".`);
    reader.readAsText(file);
  }

  private renderChips(): void {
    this.pasteChipsEl.empty();
    if (!this.pendingAttachment && this.pendingImages.length === 0) {
      this.pasteChipsEl.addClass('ct-hidden');
      return;
    }
    this.pasteChipsEl.removeClass('ct-hidden');

    if (this.pendingAttachment) {
      const chip = this.pasteChipsEl.createDiv('ct-paste-chip');
      const fileName = this.pendingAttachment.split('\n')[0].trim().slice(0, 40);
      chip.createSpan({ cls: 'ct-paste-chip-icon', text: '📄' });
      chip.createSpan({ cls: 'ct-paste-chip-label', text: fileName || 'attached file' });
      chip.createSpan({ cls: 'ct-paste-chip-meta', text: `${this.pendingAttachment.length.toLocaleString()} chars` });
      const removeBtn = chip.createEl('button', { cls: 'ct-paste-chip-remove', text: '×', attr: { title: 'Remove' } });
      removeBtn.addEventListener('click', () => {
        this.pendingAttachment = null;
        this.renderChips();
        this.options.onChipChange?.();
      });
    }

    this.pendingImages.forEach((img) => {
      const chip = this.pasteChipsEl.createDiv('ct-paste-chip ct-paste-chip-image');
      const thumb = chip.createEl('img', { cls: 'ct-paste-chip-thumb' });
      thumb.src = `data:${img.mediaType};base64,${img.base64}`;
      chip.createSpan({ cls: 'ct-paste-chip-label', text: img.name });
      const removeBtn = chip.createEl('button', { cls: 'ct-paste-chip-remove', text: '×', attr: { title: 'Remove' } });
      removeBtn.addEventListener('click', () => {
        this.pendingImages = this.pendingImages.filter(i => i !== img);
        this.renderChips();
        this.options.onChipChange?.();
      });
    });
  }

  // ── @mention autocomplete ────────────────────────────────────────────────

  private getAtQuery(): string | null {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    const word = val.slice(start + 1, pos);
    return word.startsWith('@') ? word.slice(1) : null;
  }

  private showFileDropdown(query: string): void {
    const q = query.toLowerCase();
    const showThis = this.options.showThisMention && 'this'.startsWith(q);
    const files = this.app.vault.getMarkdownFiles()
      .filter(f => q === '' || f.basename.toLowerCase().includes(q))
      .slice(0, showThis ? 19 : 20);
    const allItems: { path: string; basename: string; isThis?: boolean }[] = [
      ...(showThis ? [{ path: '', basename: 'this', isThis: true as const }] : []),
      ...files.map(f => ({ path: f.path, basename: f.basename })),
    ];
    if (allItems.length === 0) { this.hideFileDropdown(); return; }
    this.fileDropdownItems = allItems;
    if (this.fileDropdownIndex >= this.fileDropdownItems.length) this.fileDropdownIndex = 0;
    if (!this.fileDropdown) {
      this.fileDropdown = this.inputRow.createDiv('ct-file-dropdown');
    }
    this.renderFileDropdown();
  }

  private renderFileDropdown(): void {
    if (!this.fileDropdown) return;
    this.fileDropdown.empty();
    this.fileDropdownItems.forEach((file, i) => {
      const item = this.fileDropdown!.createDiv({
        cls: `ct-skill-item${i === this.fileDropdownIndex ? ' ct-skill-item-active' : ''}`,
      });
      const nameRow = item.createDiv({ cls: 'ct-skill-name' });
      nameRow.createSpan({ cls: 'ct-file-at', text: '@' });
      if (file.isThis) {
        nameRow.createSpan({ text: 'this' });
        item.createDiv({ cls: 'ct-skill-desc', text: 'currently open file' });
        item.addEventListener('mousedown', (e) => { e.preventDefault(); this.insertThisMention(); });
      } else {
        nameRow.createSpan({ text: file.basename });
        const pathParts = file.path.split('/');
        if (pathParts.length > 1) {
          const folder = pathParts.slice(0, -1).join('/');
          item.createDiv({ cls: 'ct-skill-desc', text: folder });
        }
        item.addEventListener('mousedown', (e) => { e.preventDefault(); this.insertFileMention(file.basename); });
      }
    });
  }

  private insertFileMention(basename: string): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    const inserted = `@[[${basename}]] `;
    this.inputEl.value = val.slice(0, start) + inserted + val.slice(pos);
    this.inputEl.selectionStart = this.inputEl.selectionEnd = start + inserted.length;
    this.hideFileDropdown();
    this.inputEl.focus();
  }

  private insertThisMention(): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    const inserted = '@this ';
    this.inputEl.value = val.slice(0, start) + inserted + val.slice(pos);
    this.inputEl.selectionStart = this.inputEl.selectionEnd = start + inserted.length;
    this.hideFileDropdown();
    this.inputEl.focus();
  }

  private hideFileDropdown(): void {
    this.fileDropdown?.remove();
    this.fileDropdown = null;
    this.fileDropdownItems = [];
    this.fileDropdownIndex = 0;
  }

  // ── /slash autocomplete ──────────────────────────────────────────────────

  private loadSkills(): void {
    const skillsDir = path.join(os.homedir(), '.claude', 'skills');
    try {
      this.skills = fs.readdirSync(skillsDir).map(entry => {
        const name = entry.replace(/\.md$/, '');
        const entryPath = path.join(skillsDir, entry);
        const isDir = fs.statSync(entryPath).isDirectory();
        let filePath = isDir ? '' : entryPath;
        if (isDir) {
          const candidates = ['index.md', 'skill.md', name + '.md'];
          const found = candidates.find(f => fs.existsSync(path.join(entryPath, f)));
          if (found) {
            filePath = path.join(entryPath, found);
          } else {
            const first = fs.readdirSync(entryPath).find(f => f.endsWith('.md'));
            if (first) filePath = path.join(entryPath, first);
          }
        }
        return { name, description: filePath ? this.readSkillDescription(filePath) : '' };
      });
    } catch {
      this.skills = [];
    }
  }

  private readSkillDescription(filePath: string): string {
    try {
      const content = fs.readFileSync(filePath, 'utf8').slice(0, 2000);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const inline = fm.match(/^description:\s+([^>|\n][^\n]*)/m);
        if (inline) return inline[1].trim();
        const block = fm.match(/^description:\s*>-?\s*\n((?:[ \t]+[^\n]*\n?)+)/m);
        if (block) return block[1].replace(/^[ \t]+/mg, '').replace(/\n/g, ' ').trim();
      }
      const body = content.replace(/^---[\s\S]*?---\n/, '');
      for (const line of body.split('\n')) {
        const clean = line.replace(/^#+\s*/, '').trim();
        if (clean && !clean.startsWith('---')) return clean;
      }
      return '';
    } catch {
      return '';
    }
  }

  private getSlashQuery(): string | null {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    const word = val.slice(start + 1, pos);
    return word.startsWith('/') ? word.slice(1) : null;
  }

  /**
   * Detects "/command <partial-arg>" with the cursor in the first argument
   * word and returns the matching completion options. Only commands listed in
   * options.argCompletions participate.
   */
  private getArgQuery(): { options: { name: string; description: string }[]; partial: string } | null {
    const completions = this.options.argCompletions;
    if (!completions) return null;
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const match = before.match(/^\/(\S+)\s+(\S*)$/);
    if (!match) return null;
    const options = completions[match[1].toLowerCase()];
    if (!options) return null;
    return { options, partial: match[2] };
  }

  private showSkillDropdown(query: string): void {
    const q = query.toLowerCase();
    const builtins = (this.options.builtinCommands ?? []).filter(c => c.name.startsWith(q));
    const skills = this.skills.filter(s => s.name.toLowerCase().startsWith(q));
    this.skillDropdownMode = 'command';
    this.openDropdownWith([...builtins, ...skills]);
  }

  private showArgDropdown(options: { name: string; description: string }[], partial: string): void {
    const q = partial.toLowerCase();
    this.skillDropdownMode = 'arg';
    this.openDropdownWith(options.filter(o => o.name.startsWith(q)));
  }

  private openDropdownWith(matches: { name: string; description: string }[]): void {
    if (matches.length === 0) { this.hideSkillDropdown(); return; }
    this.skillDropdownItems = matches;
    if (this.skillDropdownIndex >= matches.length) this.skillDropdownIndex = 0;
    if (!this.skillDropdown) {
      this.skillDropdown = this.inputRow.createDiv('ct-skill-dropdown');
    }
    this.renderSkillDropdown();
  }

  private renderSkillDropdown(): void {
    if (!this.skillDropdown) return;
    this.skillDropdown.empty();
    this.skillDropdownItems.forEach((skill, i) => {
      const item = this.skillDropdown!.createDiv({
        cls: `ct-skill-item${i === this.skillDropdownIndex ? ' ct-skill-item-active' : ''}`,
      });
      const nameRow = item.createDiv({ cls: 'ct-skill-name' });
      if (this.skillDropdownMode === 'command') {
        nameRow.createSpan({ cls: 'ct-skill-slash', text: '/' });
      }
      nameRow.createSpan({ text: skill.name });
      if (skill.description) {
        item.createDiv({ cls: 'ct-skill-desc', text: skill.description });
      }
      item.addEventListener('mousedown', (e) => { e.preventDefault(); this.insertSkill(skill.name); });
    });
  }

  private insertSkill(skillName: string): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    // In arg mode, replace just the partial argument word (no leading slash).
    const inserted = this.skillDropdownMode === 'arg' ? skillName + ' ' : '/' + skillName + ' ';
    this.inputEl.value = val.slice(0, start) + inserted + val.slice(pos);
    this.inputEl.selectionStart = this.inputEl.selectionEnd = start + inserted.length;
    this.hideSkillDropdown();
    this.inputEl.focus();
  }

  private hideSkillDropdown(): void {
    this.skillDropdown?.remove();
    this.skillDropdown = null;
    this.skillDropdownItems = [];
    this.skillDropdownIndex = 0;
    this.skillDropdownMode = 'command';
  }

  // ── Event handlers ───────────────────────────────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (this.fileDropdown) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.fileDropdownIndex = Math.min(this.fileDropdownIndex + 1, this.fileDropdownItems.length - 1); this.renderFileDropdown(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.fileDropdownIndex = Math.max(this.fileDropdownIndex - 1, 0); this.renderFileDropdown(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selectedItem = this.fileDropdownItems[this.fileDropdownIndex];
        if (selectedItem.isThis) {
          this.insertThisMention();
        } else {
          this.insertFileMention(selectedItem.basename);
        }
        return;
      }
      if (e.key === 'Escape') { this.hideFileDropdown(); return; }
    }
    if (this.skillDropdown) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.skillDropdownIndex = Math.min(this.skillDropdownIndex + 1, this.skillDropdownItems.length - 1); this.renderSkillDropdown(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.skillDropdownIndex = Math.max(this.skillDropdownIndex - 1, 0); this.renderSkillDropdown(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.insertSkill(this.skillDropdownItems[this.skillDropdownIndex].name); return; }
      if (e.key === 'Escape') { this.hideSkillDropdown(); return; }
    }
    // Escape while streaming triggers stop
    if (e.key === 'Escape' && this.options.showStopBtn && this.stopBtn && !this.stopBtn.hasClass('ct-hidden')) {
      this.options.onStop?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  private onInput(): void {
    this.autoGrow();
    const atQuery = this.getAtQuery();
    if (atQuery !== null) {
      this.hideSkillDropdown();
      this.showFileDropdown(atQuery);
      this.options.onInput?.();
      return;
    }
    this.hideFileDropdown();
    const slashQuery = this.getSlashQuery();
    if (slashQuery !== null) {
      this.showSkillDropdown(slashQuery);
    } else {
      const argQuery = this.getArgQuery();
      if (argQuery) this.showArgDropdown(argQuery.options, argQuery.partial);
      else this.hideSkillDropdown();
    }
    this.options.onInput?.();
  }
}

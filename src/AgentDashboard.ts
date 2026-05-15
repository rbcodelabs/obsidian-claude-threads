import { ItemView, WorkspaceLeaf, setIcon, Notice } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread, ImageAttachment, ImageMediaType } from './types';

export const AGENT_VIEW_TYPE = 'claude-threads:agents';

type RowState = 'running' | 'idle' | 'error' | 'empty';

export class AgentDashboard extends ItemView {
  private plugin: ClaudeThreadsPlugin;
  private manager: ThreadManager;
  private unsubscribe: (() => void) | null = null;

  private listEl!: HTMLElement;
  private headerCountEl!: HTMLElement;
  private dispatchInput!: HTMLTextAreaElement;
  private pasteChipsEl!: HTMLElement;
  private hiddenFileInput!: HTMLInputElement;

  // Pending image attachments for the dispatch box
  private pendingImages: ImageAttachment[] = [];

  // Per-row activity text elements for live update without full re-render
  private activityEls: Map<string, HTMLElement> = new Map();
  private timeEls: Map<string, HTMLElement> = new Map();
  // Row elements for active-thread highlighting
  private rowEls: Map<string, HTMLElement> = new Map();
  private activeThreadId: string | null = null;

  // Debounce full re-render on state changes
  private renderPending = false;
  // Debounce activity-only refresh
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  // Periodic time refresh
  private timeInterval: ReturnType<typeof setInterval> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeThreadsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.manager = plugin.manager;
  }

  getViewType(): string { return AGENT_VIEW_TYPE; }
  getDisplayText(): string { return 'Agent Dashboard'; }
  getIcon(): string { return 'layout-dashboard'; }

  async onOpen(): Promise<void> {
    this.activeThreadId = this.plugin.getActiveThreadId();
    this.buildUI();
    this.render();
    this.unsubscribe = this.manager.subscribe((threadId, event) => {
      this.handleEvent(threadId, event);
    });
    this.timeInterval = setInterval(() => this.refreshTimes(), 30_000);
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.timeInterval) clearInterval(this.timeInterval);
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-agents-root');

    const header = root.createDiv('ct-agents-header');
    const titleEl = header.createDiv('ct-agents-title');
    const iconSpan = titleEl.createSpan('ct-agents-title-icon');
    setIcon(iconSpan, 'layout-dashboard');
    titleEl.createSpan({ text: 'Agent Dashboard' });
    this.headerCountEl = header.createDiv('ct-agents-count');

    this.listEl = root.createDiv('ct-agents-list');

    const dispatchEl = root.createDiv('ct-agents-dispatch');

    // Image chip strip — hidden until images are attached
    this.pasteChipsEl = dispatchEl.createDiv('ct-paste-chips ct-agents-dispatch-chips ct-hidden');

    // Input row: textarea + attach + start buttons
    const dispatchRow = dispatchEl.createDiv('ct-agents-dispatch-row');
    this.dispatchInput = dispatchRow.createEl('textarea', {
      cls: 'ct-agents-dispatch-input',
      attr: { placeholder: 'Dispatch a task... (Enter to start, Shift+Enter for newline)' },
    });

    const attachBtn = dispatchRow.createEl('button', {
      cls: 'ct-agents-dispatch-attach-btn',
      attr: { title: 'Attach image' },
    });
    setIcon(attachBtn, 'paperclip');

    const dispatchBtn = dispatchRow.createEl('button', {
      cls: 'ct-agents-dispatch-btn',
      text: 'Start',
    });

    // Hidden file picker (triggered by attach button)
    this.hiddenFileInput = document.createElement('input');
    this.hiddenFileInput.type = 'file';
    this.hiddenFileInput.accept = 'image/*';
    this.hiddenFileInput.multiple = true;
    this.hiddenFileInput.style.display = 'none';
    this.hiddenFileInput.addEventListener('change', () => {
      Array.from(this.hiddenFileInput.files ?? []).forEach(f => this.addImageAttachment(f));
      this.hiddenFileInput.value = '';
    });
    dispatchRow.appendChild(this.hiddenFileInput);

    attachBtn.addEventListener('click', () => this.hiddenFileInput.click());
    dispatchBtn.addEventListener('click', () => this.dispatch());

    this.dispatchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.dispatch();
      }
    });

    // Paste: capture image files from clipboard
    this.dispatchInput.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      const imageFiles = files.filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        e.preventDefault();
        imageFiles.forEach(f => this.addImageAttachment(f));
      }
    });

    // Drag-and-drop images onto the dispatch area
    dispatchEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      dispatchEl.addClass('ct-drag-over');
    });
    // Only clear the highlight when the pointer truly leaves the container,
    // not when it crosses an internal child element boundary.
    dispatchEl.addEventListener('dragleave', (e) => {
      if (!dispatchEl.contains(e.relatedTarget as Node | null)) {
        dispatchEl.removeClass('ct-drag-over');
      }
    });
    dispatchEl.addEventListener('drop', (e) => {
      e.preventDefault();
      dispatchEl.removeClass('ct-drag-over');
      const files = Array.from(e.dataTransfer?.files ?? []);
      files.filter(f => f.type.startsWith('image/')).forEach(f => this.addImageAttachment(f));
    });
  }

  private handleEvent(threadId: string, event: ThreadEvent): void {
    if (event.type === 'active_thread_changed') {
      this.setActiveRow(threadId);
      return;
    }
    // When a thread finishes a new run, mark it unreviewed so it surfaces in "New"
    if (event.type === 'done') {
      const thread = this.manager.getThread(threadId);
      if (thread) {
        thread.reviewed = false;
        this.plugin.saveSettings();
      }
    }

    const isStateChange =
      event.type === 'streaming_start' ||
      event.type === 'done' ||
      event.type === 'error' ||
      event.type === 'thread_deleted' ||
      event.type === 'thread_created';
    if (isStateChange) {
      this.scheduleRender();
      return;
    }
    if (
      event.type === 'tool_use' ||
      event.type === 'task_started' ||
      event.type === 'task_progress'
    ) {
      this.scheduleActivityRefresh(threadId);
    }
  }

  private setActiveRow(threadId: string): void {
    // Remove active class from previous row
    if (this.activeThreadId) {
      this.rowEls.get(this.activeThreadId)?.removeClass('ct-agents-row-active');
    }
    this.activeThreadId = threadId;
    this.rowEls.get(threadId)?.addClass('ct-agents-row-active');
  }

  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    setTimeout(() => {
      this.renderPending = false;
      this.render();
    }, 0);
  }

  private scheduleActivityRefresh(threadId: string): void {
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      const el = this.activityEls.get(threadId);
      if (el && this.manager.isRunning(threadId)) {
        const thread = this.manager.getThread(threadId);
        if (thread) el.setText(this.getActivityText(thread, 'running'));
      }
    }, 800);
  }

  render(): void {
    this.listEl.empty();
    this.activityEls.clear();
    this.timeEls.clear();
    this.rowEls.clear();

    const threads = this.manager.getThreads();
    const running: Thread[] = [];
    const unreviewed: Thread[] = [];
    const reviewed: Thread[] = [];
    const errors: Thread[] = [];
    const empty: Thread[] = [];

    for (const t of threads) {
      if (this.manager.isRunning(t.id)) running.push(t);
      else if (t.lastError) errors.push(t);
      else if (t.messages.length > 0) {
        if (t.reviewed) reviewed.push(t);
        else unreviewed.push(t);
      } else empty.push(t);
    }

    // Sort each group by most recently updated first
    const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
    running.sort(byRecency);
    unreviewed.sort(byRecency);
    reviewed.sort(byRecency);
    errors.sort(byRecency);
    empty.sort(byRecency);

    if (threads.length === 0) {
      const emptyEl = this.listEl.createDiv('ct-agents-empty');
      emptyEl.createDiv({ text: 'No threads yet.' });
      emptyEl.createDiv({ cls: 'ct-agents-empty-sub', text: 'Use the dispatch input below to start a task.' });
    }

    if (running.length > 0) this.renderGroup('Working', running, 'running');
    if (unreviewed.length > 0) this.renderGroup('New', unreviewed, 'idle', unreviewed.length);
    if (reviewed.length > 0) this.renderGroup('Reviewed', reviewed, 'idle');
    if (errors.length > 0) this.renderGroup('Failed', errors, 'error');
    if (empty.length > 0) this.renderGroup('Ready', empty, 'empty');

    this.updateHeader(threads.length, running.length);
  }

  private renderGroup(label: string, threads: Thread[], state: RowState, badge?: number): void {
    const group = this.listEl.createDiv('ct-agents-group');
    const labelEl = group.createDiv('ct-agents-group-label');
    labelEl.createSpan({ text: label });
    if (badge !== undefined) {
      labelEl.createSpan({ cls: 'ct-agents-group-badge', text: String(badge) });
    }
    for (const thread of threads) {
      this.renderRow(thread, state, group);
    }
  }

  private renderRow(thread: Thread, state: RowState, parent: HTMLElement): void {
    const isActive = thread.id === this.activeThreadId;
    const isUnreviewed = state === 'idle' && !thread.reviewed;
    const row = parent.createDiv({
      cls: `ct-agents-row ct-agents-row-${state}${isActive ? ' ct-agents-row-active' : ''}${isUnreviewed ? ' ct-agents-row-unreviewed' : ''}`,
    });
    this.rowEls.set(thread.id, row);

    const iconEl = row.createDiv('ct-agents-icon');
    this.applyStateIcon(iconEl, state);

    const body = row.createDiv('ct-agents-row-body');
    body.createDiv({ cls: 'ct-agents-row-title', text: thread.title });

    // Show full summary for completed threads — this is the canonical home for summaries
    const summary = thread.summary || thread.recap;
    if (summary && state === 'idle') {
      body.createDiv({ cls: 'ct-agents-row-summary', text: summary });
    }

    const activityEl = body.createDiv({ cls: 'ct-agents-row-activity' });
    activityEl.setText(this.getActivityText(thread, state));
    this.activityEls.set(thread.id, activityEl);

    const meta = row.createDiv('ct-agents-row-meta');
    const timeEl = meta.createDiv({ cls: 'ct-agents-row-time', text: relativeTime(thread.updatedAt) });
    this.timeEls.set(thread.id, timeEl);
    if (thread.cwd) {
      meta.createDiv({ cls: 'ct-agents-row-cwd', text: shortenPath(thread.cwd, this.plugin.manager.vaultRoot) });
    }

    row.addEventListener('click', () => {
      if (state === 'idle' && !thread.reviewed) this.markReviewed(thread.id);
      this.plugin.openThreadInChatView(thread.id);
    });
  }

  private applyStateIcon(el: HTMLElement, state: RowState): void {
    el.className = `ct-agents-icon ct-agents-icon-${state}`;
    switch (state) {
      case 'running': el.setText('✽'); break;
      case 'idle':    el.setText('✓'); break;
      case 'error':   el.setText('✗'); break;
      default:        el.setText('○'); break;
    }
  }

  private getActivityText(thread: Thread, state: RowState): string {
    if (state === 'running') {
      return this.manager.getThreadActivity(thread.id) || 'Working...';
    }
    if (state === 'error') return thread.lastError ?? 'Error occurred';
    if (state === 'empty') return 'Ready to start';
    // Summary is shown in its own element above; fall back to last message preview
    const lastAssistant = [...thread.messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant) {
      const text = lastAssistant.content.replace(/```[\s\S]*?```/g, '[code]').replace(/\n/g, ' ').trim();
      return text.length > 90 ? text.slice(0, 90) + '…' : text;
    }
    return 'Completed';
  }

  private refreshTimes(): void {
    for (const [id, el] of this.timeEls) {
      const thread = this.manager.getThread(id);
      if (thread) el.setText(relativeTime(thread.updatedAt));
    }
  }

  private updateHeader(total: number, running: number): void {
    if (running > 0) {
      this.headerCountEl.setText(`${running} running · ${total} total`);
    } else {
      this.headerCountEl.setText(`${total} thread${total !== 1 ? 's' : ''}`);
    }
  }

  private markReviewed(id: string): void {
    const thread = this.manager.getThread(id);
    if (!thread) return;
    thread.reviewed = true;
    this.plugin.saveSettings();
    this.scheduleRender();
  }

  /** Open the most recently completed unreviewed thread and mark it reviewed.
   *  Can be called repeatedly to triage through the queue. */
  public jumpToLatestUnreviewed(): void {
    const candidate = this.manager.getThreads()
      .filter(t => !this.manager.isRunning(t.id) && !t.lastError && t.messages.length > 0 && !t.reviewed)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (!candidate) {
      new Notice('No unreviewed completed agents');
      return;
    }
    this.markReviewed(candidate.id);
    this.plugin.openThreadInChatView(candidate.id);
  }

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
      this.renderDispatchChips();
    };
    reader.readAsDataURL(file);
  }

  private renderDispatchChips(): void {
    this.pasteChipsEl.empty();
    if (this.pendingImages.length === 0) {
      this.pasteChipsEl.addClass('ct-hidden');
      return;
    }
    this.pasteChipsEl.removeClass('ct-hidden');

    this.pendingImages.forEach((img) => {
      const chip = this.pasteChipsEl.createDiv('ct-paste-chip ct-paste-chip-image');
      const thumb = chip.createEl('img', { cls: 'ct-paste-chip-thumb' });
      thumb.src = `data:${img.mediaType};base64,${img.base64}`;
      chip.createSpan({ cls: 'ct-paste-chip-label', text: img.name });
      const removeBtn = chip.createEl('button', {
        cls: 'ct-paste-chip-remove',
        text: '×',
        attr: { title: 'Remove' },
      });
      // Remove by identity rather than index — safe against re-render races
      removeBtn.addEventListener('click', () => {
        this.pendingImages = this.pendingImages.filter(i => i !== img);
        this.renderDispatchChips();
      });
    });
  }

  private dispatching = false;

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    const text = this.dispatchInput.value.trim();
    const images = this.pendingImages.slice();
    if (text.length < 2 && images.length === 0) return;

    this.dispatching = true;
    this.dispatchInput.value = '';
    this.pendingImages = [];
    this.renderDispatchChips();

    try {
      // Pass a single space when there's no text so ClaudeSession sees a non-empty prompt
      const effectiveText = text || ' ';
      const threadId = await this.plugin.dispatchNewThread(effectiveText, images.length > 0 ? images : undefined);
      await this.plugin.openThreadInChatView(threadId);
      this.render();
    } finally {
      this.dispatching = false;
    }
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortenPath(p: string, vaultRoot?: string): string {
  if (vaultRoot && p.startsWith(vaultRoot)) {
    const rel = p.slice(vaultRoot.length).replace(/^\//, '');
    return rel || '/';
  }
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  const parts = p.split('/');
  return parts.length > 4 ? '…/' + parts.slice(-2).join('/') : p;
}

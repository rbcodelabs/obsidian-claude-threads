import { ItemView, WorkspaceLeaf, setIcon, Notice } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread, ImageAttachment, ImageMediaType } from './types';
import { MAX_ATTACHMENT_BYTES, buildMessageWithAttachment, deriveDispatchTitle } from './attachmentUtils';
import { formatToolName } from './ClaudeSession';
import { relativeTime, shortenPath, isAwsSsoError, extractAwsProfile } from './dashboardUtils';
import { SttController } from './stt';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const AGENT_VIEW_TYPE = 'claude-threads:agents';

type RowState = 'running' | 'idle' | 'error' | 'empty';

export class AgentDashboard extends ItemView {
  private plugin: ClaudeThreadsPlugin;
  private manager: ThreadManager;
  private unsubscribe: (() => void) | null = null;

  private listEl!: HTMLElement;
  private headerCountEl!: HTMLElement;
  private searchBarEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private searchClearBtn!: HTMLButtonElement;
  private searchBtn!: HTMLButtonElement;
  private searchQuery = '';
  private kanbanMode = false;
  private dispatchInput!: HTMLTextAreaElement;
  private dispatchRow!: HTMLElement;
  private pasteChipsEl!: HTMLElement;
  private hiddenFileInput!: HTMLInputElement;

  // Pending attachments for the dispatch box
  private pendingImages: ImageAttachment[] = [];
  private pendingAttachment: string | null = null;

  // @ file mention dropdown state
  private fileDropdown: HTMLElement | null = null;
  private fileDropdownItems: { path: string; basename: string }[] = [];
  private fileDropdownIndex = 0;

  // / slash command autocomplete state
  private skills: { name: string; description: string }[] = [];
  private skillDropdown: HTMLElement | null = null;
  private skillDropdownItems: { name: string; description: string }[] = [];
  private skillDropdownIndex = 0;

  private static readonly BUILTIN_COMMANDS: { name: string; description: string }[] = [
    { name: 'compact', description: 'Summarize conversation history to free up context' },
    { name: 'clear', description: 'Clear conversation history and start fresh' },
    { name: 'cost', description: 'Show token usage and cost for this session' },
    { name: 'model', description: 'Set persistent model: /model opus|sonnet|haiku|default' },
  ];

  // Per-row activity text elements for live update without full re-render
  private activityEls: Map<string, HTMLElement> = new Map();
  private timeEls: Map<string, HTMLElement> = new Map();
  // Row elements for active-thread highlighting
  private rowEls: Map<string, HTMLElement> = new Map();
  private activeThreadId: string | null = null;

  // Speech-to-text controller for the dispatch input
  private sttController: SttController | null = null;

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
    // Restore the last-used view mode (defaults to list view / false)
    this.kanbanMode = this.plugin.settings.agentDashboardKanbanMode ?? false;
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
    this.sttController?.destroy();
  }

  private buildUI(): void {
    this.loadSkills();
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-agents-root');

    const header = root.createDiv('ct-agents-header');
    const titleEl = header.createDiv('ct-agents-title');
    const iconSpan = titleEl.createSpan('ct-agents-title-icon');
    setIcon(iconSpan, 'layout-dashboard');
    titleEl.createSpan({ text: 'Agent Dashboard' });

    const headerRight = header.createDiv('ct-agents-header-right');
    this.headerCountEl = headerRight.createDiv('ct-agents-count');
    this.searchBtn = headerRight.createEl('button', {
      cls: 'ct-agents-search-btn clickable-icon',
      attr: { title: 'Search threads', 'aria-label': 'Search threads' },
    });
    setIcon(this.searchBtn, 'search');
    this.searchBtn.addEventListener('click', () => this.toggleSearch());

    const kanbanBtn = headerRight.createEl('button', {
      cls: 'ct-kanban-toggle clickable-icon',
      attr: { title: 'Open Kanban Board', 'aria-label': 'Open Kanban Board' },
    });
    setIcon(kanbanBtn, 'layout-grid');
    kanbanBtn.addEventListener('click', () => {
      this.plugin.activateKanbanView();
    });

    this.searchBarEl = root.createDiv('ct-agents-search-bar ct-hidden');
    const searchFieldEl = this.searchBarEl.createDiv('ct-agents-search-field');
    this.searchInputEl = searchFieldEl.createEl('input', {
      cls: 'ct-agents-search-input',
      attr: { type: 'text', placeholder: 'Search threads…' },
    });
    this.searchClearBtn = searchFieldEl.createEl('button', {
      cls: 'ct-agents-search-clear ct-hidden',
      attr: { type: 'button', 'aria-label': 'Clear search' },
    });
    setIcon(this.searchClearBtn, 'x');
    this.searchClearBtn.addEventListener('click', () => {
      this.searchInputEl.value = '';
      this.searchQuery = '';
      this.searchClearBtn.addClass('ct-hidden');
      this.searchInputEl.focus();
      this.render();
    });
    this.searchInputEl.addEventListener('input', () => {
      this.searchQuery = this.searchInputEl.value.toLowerCase().trim();
      this.searchClearBtn.toggleClass('ct-hidden', this.searchInputEl.value === '');
      this.render();
    });
    this.searchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeSearch();
    });

    this.listEl = root.createDiv('ct-agents-list');

    const dispatchEl = root.createDiv('ct-agents-dispatch');

    // Image chip strip — hidden until images are attached
    this.pasteChipsEl = dispatchEl.createDiv('ct-paste-chips ct-agents-dispatch-chips ct-hidden');

    // Input row: textarea + stacked action buttons (mirrors chat ct-input-controls layout)
    this.dispatchRow = dispatchEl.createDiv('ct-agents-dispatch-row');
    const dispatchRow = this.dispatchRow;
    this.dispatchInput = dispatchRow.createEl('textarea', {
      cls: 'ct-agents-dispatch-input',
      attr: { placeholder: 'Dispatch a task... (Enter to start, Shift+Enter for newline)' },
    });

    const inputActions = dispatchRow.createDiv('ct-input-actions');

    const dispatchBtn = inputActions.createEl('button', {
      cls: 'ct-send-btn ct-agents-dispatch-btn',
      text: '▶',
      attr: { title: 'Start task' },
    });

    const attachBtn = inputActions.createEl('button', {
      cls: 'ct-more-btn ct-agents-dispatch-attach-btn',
      attr: { title: 'Attach file' },
    });
    setIcon(attachBtn, 'paperclip');

    // Hidden file picker (triggered by attach button)
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
    dispatchRow.appendChild(this.hiddenFileInput);

    dispatchBtn.addEventListener('click', () => this.dispatch());
    attachBtn.addEventListener('click', () => this.hiddenFileInput.click());

    // Mic button for speech-to-text
    this.sttController = new SttController(this.app);
    const micBtn = this.sttController.createMicButton(this.dispatchInput);
    inputActions.appendChild(micBtn);

    this.dispatchInput.addEventListener('keydown', (e) => {
      if (this.fileDropdown) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.fileDropdownIndex = Math.min(this.fileDropdownIndex + 1, this.fileDropdownItems.length - 1);
          this.renderFileDropdown();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.fileDropdownIndex = Math.max(this.fileDropdownIndex - 1, 0);
          this.renderFileDropdown();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          this.insertFileMention(this.fileDropdownItems[this.fileDropdownIndex].basename);
          return;
        }
        if (e.key === 'Escape') {
          this.hideFileDropdown();
          return;
        }
      }
      if (this.skillDropdown) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.skillDropdownIndex = Math.min(this.skillDropdownIndex + 1, this.skillDropdownItems.length - 1);
          this.renderSkillDropdown();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.skillDropdownIndex = Math.max(this.skillDropdownIndex - 1, 0);
          this.renderSkillDropdown();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          this.insertSkill(this.skillDropdownItems[this.skillDropdownIndex].name);
          return;
        }
        if (e.key === 'Escape') {
          this.hideSkillDropdown();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.dispatch();
      }
    });

    this.dispatchInput.addEventListener('input', () => {
      const atQuery = this.getAtQuery();
      if (atQuery !== null) {
        this.hideSkillDropdown();
        this.showFileDropdown(atQuery);
        return;
      }
      this.hideFileDropdown();
      const slashQuery = this.getSlashQuery();
      if (slashQuery !== null) this.showSkillDropdown(slashQuery);
      else this.hideSkillDropdown();
    });

    this.dispatchInput.addEventListener('blur', () => {
      // Delay so mousedown on a dropdown item fires before blur hides it
      setTimeout(() => {
        this.hideFileDropdown();
        this.hideSkillDropdown();
      }, 150);
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
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          this.addImageAttachment(file);
        } else {
          this.addFileAsTextAttachment(file);
        }
      }
    });
  }

  private handleEvent(threadId: string, event: ThreadEvent): void {
    if (event.type === 'active_thread_changed') {
      this.setActiveRow(threadId);
      return;
    }
    if (event.type === 'permission_request' || event.type === 'permission_resolved') {
      this.scheduleRender();
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
    if (this.kanbanMode) {
      this.renderKanban();
      return;
    }

    this.listEl.empty();
    this.activityEls.clear();
    this.timeEls.clear();
    this.rowEls.clear();

    const q = this.searchQuery;
    const allThreads = this.manager.getThreads();
    const threads = q
      ? allThreads.filter(t =>
          t.title.toLowerCase().includes(q) ||
          (t.summary ?? '').toLowerCase().includes(q) ||
          (t.recap ?? '').toLowerCase().includes(q)
        )
      : allThreads;
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
      if (q) {
        emptyEl.createDiv({ text: 'No threads match your search.' });
      } else {
        emptyEl.createDiv({ text: 'No threads yet.' });
        emptyEl.createDiv({ cls: 'ct-agents-empty-sub', text: 'Use the dispatch input below to start a task.' });
      }
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
    const hasPending = state === 'running' && this.manager.hasPendingPermission(thread.id);
    const row = parent.createDiv({
      cls: `ct-agents-row ct-agents-row-${state}${isActive ? ' ct-agents-row-active' : ''}${isUnreviewed ? ' ct-agents-row-unreviewed' : ''}${hasPending ? ' ct-agents-row-permission' : ''}`,
    });
    this.rowEls.set(thread.id, row);

    const iconEl = row.createDiv('ct-agents-icon');
    if (hasPending) {
      iconEl.addClass('ct-agents-icon-permission');
      iconEl.setText('?');
    } else {
      this.applyStateIcon(iconEl, state);
    }

    const body = row.createDiv('ct-agents-row-body');
    body.createDiv({ cls: 'ct-agents-row-title', text: thread.title });

    // Show full summary for completed threads — this is the canonical home for summaries
    const summary = thread.summary || thread.recap;
    if (summary && state === 'idle') {
      body.createDiv({ cls: 'ct-agents-row-summary', text: summary });
    }

    const activityEl = body.createDiv({ cls: 'ct-agents-row-activity' });
    this.activityEls.set(thread.id, activityEl);

    if (hasPending) {
      const pendingInfo = this.manager.getPendingPermission(thread.id);
      activityEl.createSpan({ cls: 'ct-agents-permission-tool', text: pendingInfo?.toolName ? formatToolName(pendingInfo.toolName) : 'permission' });
      if (pendingInfo?.detail) {
        activityEl.createSpan({ cls: 'ct-agents-permission-detail', text: pendingInfo.detail });
      }

      const btns = body.createDiv({ cls: 'ct-agents-permission-actions' });

      const deny = btns.createEl('button', { text: 'Deny', cls: 'ct-permission-btn ct-permission-deny' });
      deny.addEventListener('click', (e) => { e.stopPropagation(); this.manager.resolvePermission(thread.id, false); });

      const allow = btns.createEl('button', { text: 'Allow', cls: 'ct-permission-btn ct-permission-allow' });
      allow.addEventListener('click', (e) => { e.stopPropagation(); this.manager.resolvePermission(thread.id, true); });

      const always = btns.createEl('button', { text: 'Always Allow', cls: 'ct-permission-btn ct-permission-always' });
      always.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (pendingInfo) {
          this.plugin.settings.alwaysAllowedTools.push(pendingInfo.toolName);
          await this.plugin.saveSettings();
        }
        this.manager.resolvePermission(thread.id, true);
      });
    } else {
      activityEl.setText(this.getActivityText(thread, state));

      // ── AWS SSO reauth button ────────────────────────────────────────────
      // When the session failed due to an expired SSO token, show a one-click
      // "Re-authenticate" button so the user doesn't have to leave Obsidian.
      if (state === 'error' && isAwsSsoError(thread.lastError)) {
        const profile = extractAwsProfile(this.plugin.settings.extraEnv ?? '');
        const reauthBtn = body.createEl('button', {
          cls: 'ct-aws-reauth-btn',
          text: '🔑 Re-authenticate AWS SSO',
        });
        reauthBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          reauthBtn.setText('Authenticating…');
          reauthBtn.disabled = true;
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { exec } = require('child_process') as typeof import('child_process');
            const cmd = profile ? `aws sso login --profile ${profile}` : 'aws sso login';
            await new Promise<void>((resolve, reject) => {
              exec(cmd, (err, _stdout, stderr) => {
                if (err) reject(new Error(stderr?.trim() || err.message));
                else resolve();
              });
            });
            new Notice('AWS SSO login successful — retry your request');
            reauthBtn.setText('✓ Done — retry your request');
          } catch (err) {
            new Notice(`AWS SSO login failed: ${(err as Error).message}`);
            reauthBtn.setText('🔑 Re-authenticate AWS SSO');
            reauthBtn.disabled = false;
          }
        });
      }
    }

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

  private updateKanbanToggleIcon(btn: HTMLElement): void {
    // Show the icon for what the view would switch TO
    setIcon(btn, this.kanbanMode ? 'list' : 'layout-grid');
    btn.setAttribute('title', this.kanbanMode ? 'Switch to list view' : 'Switch to kanban view');
  }

  private renderKanban(): void {
    this.listEl.empty();
    this.activityEls.clear();
    this.timeEls.clear();
    this.rowEls.clear();

    const q = this.searchQuery;
    const allThreads = this.manager.getThreads();
    const threads = q
      ? allThreads.filter(t =>
          t.title.toLowerCase().includes(q) ||
          (t.summary ?? '').toLowerCase().includes(q) ||
          (t.recap ?? '').toLowerCase().includes(q)
        )
      : allThreads;

    const running: Thread[] = [];
    const permReqs: Thread[] = [];
    const unreviewed: Thread[] = [];
    const reviewed: Thread[] = [];
    const errors: Thread[] = [];
    const empty: Thread[] = [];

    for (const t of threads) {
      if (this.manager.isRunning(t.id)) {
        if (this.manager.hasPendingPermission(t.id)) permReqs.push(t);
        else running.push(t);
      } else if (t.lastError) {
        errors.push(t);
      } else if (t.messages.length > 0) {
        if (t.reviewed) reviewed.push(t);
        else unreviewed.push(t);
      } else {
        empty.push(t);
      }
    }

    const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
    running.sort(byRecency);
    permReqs.sort(byRecency);
    unreviewed.sort(byRecency);
    reviewed.sort(byRecency);
    errors.sort(byRecency);
    empty.sort(byRecency);

    if (threads.length === 0) {
      const emptyEl = this.listEl.createDiv('ct-agents-empty');
      if (q) {
        emptyEl.createDiv({ text: 'No threads match your search.' });
      } else {
        emptyEl.createDiv({ text: 'No threads yet.' });
        emptyEl.createDiv({ cls: 'ct-agents-empty-sub', text: 'Use the dispatch input below to start a task.' });
      }
      this.updateHeader(0, 0);
      return;
    }

    const board = this.listEl.createDiv('ct-kanban-board');

    type ColDef = { label: string; threads: Thread[]; state: RowState; accentClass?: string; badge?: number };
    const cols: ColDef[] = [
      { label: 'Working', threads: running, state: 'running' },
      { label: 'Awaiting', threads: permReqs, state: 'running', accentClass: 'ct-kanban-col-permission' },
      { label: 'New', threads: unreviewed, state: 'idle', badge: unreviewed.length > 0 ? unreviewed.length : undefined },
      { label: 'Done', threads: reviewed, state: 'idle' },
      { label: 'Failed', threads: errors, state: 'error' },
      { label: 'Ready', threads: empty, state: 'empty' },
    ];

    for (const col of cols) {
      const alwaysShow = col.label === 'Working' || col.label === 'New';
      if (!alwaysShow && col.threads.length === 0) continue;
      this.renderKanbanColumn(board, col.label, col.threads, col.state, col.accentClass, col.badge);
    }

    this.updateHeader(threads.length, running.length + permReqs.length);
  }

  private renderKanbanColumn(
    board: HTMLElement,
    label: string,
    threads: Thread[],
    state: RowState,
    accentClass?: string,
    badge?: number,
  ): void {
    const col = board.createDiv('ct-kanban-col' + (accentClass ? ' ' + accentClass : ''));

    const header = col.createDiv('ct-kanban-col-header');
    const headerLeft = header.createDiv('ct-kanban-col-header-left');
    headerLeft.createSpan({ cls: 'ct-kanban-col-label', text: label });
    if (badge !== undefined) {
      headerLeft.createSpan({ cls: 'ct-agents-group-badge ct-kanban-badge', text: String(badge) });
    }
    header.createSpan({ cls: 'ct-kanban-col-count', text: String(threads.length) });

    const body = col.createDiv('ct-kanban-col-body');
    if (threads.length === 0) {
      body.createDiv({ cls: 'ct-kanban-col-empty', text: 'Nothing here' });
    }
    for (const thread of threads) {
      this.renderKanbanCard(thread, state, body);
    }
  }

  private renderKanbanCard(thread: Thread, state: RowState, parent: HTMLElement): void {
    const isActive = thread.id === this.activeThreadId;
    const isUnreviewed = state === 'idle' && !thread.reviewed;
    const hasPending = state === 'running' && this.manager.hasPendingPermission(thread.id);

    const card = parent.createDiv({
      cls: [
        'ct-kanban-card',
        `ct-kanban-card-${state}`,
        isActive ? 'ct-agents-row-active' : '',
        isUnreviewed ? 'ct-kanban-card-unreviewed' : '',
        hasPending ? 'ct-kanban-card-permission' : '',
      ].filter(Boolean).join(' '),
    });
    this.rowEls.set(thread.id, card);

    // Header: icon + title
    const cardHeader = card.createDiv('ct-kanban-card-header');
    const iconEl = cardHeader.createDiv('');
    if (hasPending) {
      iconEl.className = 'ct-kanban-card-icon ct-kanban-icon-permission';
      iconEl.setText('?');
    } else {
      this.applyKanbanStateIcon(iconEl, state);
    }
    cardHeader.createDiv({ cls: 'ct-kanban-card-title', text: thread.title });

    // Summary (idle threads only)
    const summary = thread.summary || thread.recap;
    if (summary && state === 'idle') {
      card.createDiv({ cls: 'ct-kanban-card-summary', text: summary });
    }

    if (hasPending) {
      const pendingInfo = this.manager.getPendingPermission(thread.id);
      const permContent = card.createDiv('ct-kanban-card-permission-content');
      const toolRow = permContent.createDiv('ct-kanban-card-perm-tool');
      toolRow.createSpan({ cls: 'ct-agents-permission-tool', text: pendingInfo?.toolName ? formatToolName(pendingInfo.toolName) : 'permission' });
      if (pendingInfo?.detail) {
        toolRow.createSpan({ cls: 'ct-agents-permission-detail ct-kanban-perm-detail', text: pendingInfo.detail });
      }
      const activityEl = permContent.createDiv('ct-kanban-card-activity');
      this.activityEls.set(thread.id, activityEl);

      const btns = card.createDiv('ct-kanban-perm-actions');
      const deny = btns.createEl('button', { text: 'Deny', cls: 'ct-permission-btn ct-permission-deny' });
      deny.addEventListener('click', (e) => { e.stopPropagation(); this.manager.resolvePermission(thread.id, false); });
      const allow = btns.createEl('button', { text: 'Allow', cls: 'ct-permission-btn ct-permission-allow' });
      allow.addEventListener('click', (e) => { e.stopPropagation(); this.manager.resolvePermission(thread.id, true); });
      const always = btns.createEl('button', { text: 'Always', cls: 'ct-permission-btn ct-permission-always' });
      always.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (pendingInfo) {
          this.plugin.settings.alwaysAllowedTools.push(pendingInfo.toolName);
          await this.plugin.saveSettings();
        }
        this.manager.resolvePermission(thread.id, true);
      });
    } else {
      const activityEl = card.createDiv({ cls: 'ct-kanban-card-activity' });
      this.activityEls.set(thread.id, activityEl);
      activityEl.setText(this.getActivityText(thread, state));

      // AWS SSO reauth button for expired tokens
      if (state === 'error' && isAwsSsoError(thread.lastError)) {
        const profile = extractAwsProfile(this.plugin.settings.extraEnv ?? '');
        const reauthBtn = card.createEl('button', {
          cls: 'ct-aws-reauth-btn',
          text: '🔑 Re-authenticate AWS SSO',
        });
        reauthBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          reauthBtn.setText('Authenticating…');
          reauthBtn.disabled = true;
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { exec } = require('child_process') as typeof import('child_process');
            const cmd = profile ? `aws sso login --profile ${profile}` : 'aws sso login';
            await new Promise<void>((resolve, reject) => {
              exec(cmd, (err, _stdout, stderr) => {
                if (err) reject(new Error(stderr?.trim() || err.message));
                else resolve();
              });
            });
            new Notice('AWS SSO login successful — retry your request');
            reauthBtn.setText('✓ Done — retry your request');
          } catch (err) {
            new Notice(`AWS SSO login failed: ${(err as Error).message}`);
            reauthBtn.setText('🔑 Re-authenticate AWS SSO');
            reauthBtn.disabled = false;
          }
        });
      }
    }

    // Footer chips
    const footer = card.createDiv('ct-kanban-card-footer');

    const timeEl = footer.createDiv({ cls: 'ct-kanban-chip ct-kanban-chip-time', text: relativeTime(thread.updatedAt) });
    this.timeEls.set(thread.id, timeEl);

    if ((thread.editedFiles?.length ?? 0) > 0) {
      const filesChip = footer.createDiv('ct-kanban-chip ct-kanban-chip-files');
      const iconSpan = filesChip.createSpan();
      setIcon(iconSpan, 'file-text');
      filesChip.createSpan({ text: String(thread.editedFiles!.length) });
    }

    if (thread.prUrl) {
      const prChip = footer.createEl('a', { cls: 'ct-kanban-chip ct-kanban-chip-pr', text: 'PR' });
      prChip.href = '#';
      prChip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(thread.prUrl, '_blank');
      });
    }

    if (thread.cwd) {
      footer.createDiv({ cls: 'ct-kanban-chip ct-kanban-chip-cwd', text: shortenPath(thread.cwd, this.plugin.manager.vaultRoot) });
    }

    if (thread.messages.length > 0) {
      const msgChip = footer.createDiv('ct-kanban-chip ct-kanban-chip-msgs');
      const iconSpan = msgChip.createSpan();
      setIcon(iconSpan, 'message-circle');
      msgChip.createSpan({ text: String(thread.messages.length) });
    }

    card.addEventListener('click', () => {
      if (state === 'idle' && !thread.reviewed) this.markReviewed(thread.id);
      this.plugin.openThreadInChatView(thread.id);
    });
  }

  private applyKanbanStateIcon(el: HTMLElement, state: RowState): void {
    el.className = `ct-kanban-card-icon ct-kanban-icon-${state}`;
    switch (state) {
      case 'running': el.setText('✽'); break;
      case 'idle':    el.setText('✓'); break;
      case 'error':   el.setText('✗'); break;
      default:        el.setText('○'); break;
    }
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

  /** Focus the dispatch input so the user can type a task immediately. */
  public focusDispatchInput(): void {
    this.dispatchInput?.focus();
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

  private addFileAsTextAttachment(file: File): void {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      new Notice(`"${file.name}" is too large to attach (max 500 KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // Filename on the first line so the chip label and Claude's context both show it
      this.pendingAttachment = `${file.name}\n${reader.result as string}`;
      this.renderDispatchChips();
    };
    reader.onerror = () => new Notice(`Could not read "${file.name}".`);
    reader.readAsText(file);
  }

  private renderDispatchChips(): void {
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
        this.renderDispatchChips();
      });
    }

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

  // ── @ file mention helpers ──────────────────────────────────────────────

  private getAtQuery(): string | null {
    const val = this.dispatchInput.value;
    const pos = this.dispatchInput.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    const word = val.slice(start + 1, pos);
    return word.startsWith('@') ? word.slice(1) : null;
  }

  private showFileDropdown(query: string): void {
    const q = query.toLowerCase();
    const files = this.app.vault.getMarkdownFiles()
      .filter(f => q === '' || f.basename.toLowerCase().includes(q))
      .slice(0, 20);
    if (files.length === 0) { this.hideFileDropdown(); return; }
    this.fileDropdownItems = files.map(f => ({ path: f.path, basename: f.basename }));
    if (this.fileDropdownIndex >= this.fileDropdownItems.length) this.fileDropdownIndex = 0;
    if (!this.fileDropdown) {
      this.fileDropdown = this.dispatchRow.createDiv('ct-file-dropdown');
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
      nameRow.createSpan({ text: file.basename });
      const pathParts = file.path.split('/');
      if (pathParts.length > 1) {
        const folder = pathParts.slice(0, -1).join('/');
        item.createDiv({ cls: 'ct-skill-desc', text: folder });
      }
      item.addEventListener('mousedown', (e) => { e.preventDefault(); this.insertFileMention(file.basename); });
    });
  }

  private insertFileMention(basename: string): void {
    const val = this.dispatchInput.value;
    const pos = this.dispatchInput.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    const inserted = `@[[${basename}]] `;
    this.dispatchInput.value = val.slice(0, start) + inserted + val.slice(pos);
    this.dispatchInput.selectionStart = this.dispatchInput.selectionEnd = start + inserted.length;
    this.hideFileDropdown();
    this.dispatchInput.focus();
  }

  private hideFileDropdown(): void {
    this.fileDropdown?.remove();
    this.fileDropdown = null;
    this.fileDropdownItems = [];
    this.fileDropdownIndex = 0;
  }

  // ── / slash command helpers ─────────────────────────────────────────────

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
    const val = this.dispatchInput.value;
    const pos = this.dispatchInput.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    const word = val.slice(start + 1, pos);
    return word.startsWith('/') ? word.slice(1) : null;
  }

  private showSkillDropdown(query: string): void {
    const q = query.toLowerCase();
    const builtins = AgentDashboard.BUILTIN_COMMANDS.filter(c => c.name.startsWith(q));
    const skills = this.skills.filter(s => s.name.toLowerCase().startsWith(q));
    const matches = [...builtins, ...skills];
    if (matches.length === 0) { this.hideSkillDropdown(); return; }
    this.skillDropdownItems = matches;
    if (this.skillDropdownIndex >= matches.length) this.skillDropdownIndex = 0;
    if (!this.skillDropdown) {
      this.skillDropdown = this.dispatchRow.createDiv('ct-skill-dropdown');
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
      nameRow.createSpan({ cls: 'ct-skill-slash', text: '/' });
      nameRow.createSpan({ text: skill.name });
      if (skill.description) {
        item.createDiv({ cls: 'ct-skill-desc', text: skill.description });
      }
      item.addEventListener('mousedown', (e) => { e.preventDefault(); this.insertSkill(skill.name); });
    });
  }

  private insertSkill(skillName: string): void {
    const val = this.dispatchInput.value;
    const pos = this.dispatchInput.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    const inserted = '/' + skillName + ' ';
    this.dispatchInput.value = val.slice(0, start) + inserted + val.slice(pos);
    this.dispatchInput.selectionStart = this.dispatchInput.selectionEnd = start + inserted.length;
    this.hideSkillDropdown();
    this.dispatchInput.focus();
  }

  private hideSkillDropdown(): void {
    this.skillDropdown?.remove();
    this.skillDropdown = null;
    this.skillDropdownItems = [];
    this.skillDropdownIndex = 0;
  }

  // ── Search ──────────────────────────────────────────────────────────────

  private toggleSearch(): void {
    if (this.searchBarEl.hasClass('ct-hidden')) {
      this.searchBarEl.removeClass('ct-hidden');
      setIcon(this.searchBtn, 'x');
      this.searchBtn.setAttribute('title', 'Close search');
      this.searchBtn.setAttribute('aria-label', 'Close search');
      this.searchInputEl.focus();
    } else {
      this.closeSearch();
    }
  }

  private closeSearch(): void {
    this.searchBarEl.addClass('ct-hidden');
    this.searchQuery = '';
    this.searchInputEl.value = '';
    this.searchClearBtn.addClass('ct-hidden');
    setIcon(this.searchBtn, 'search');
    this.searchBtn.setAttribute('title', 'Search threads');
    this.searchBtn.setAttribute('aria-label', 'Search threads');
    this.render();
  }

  // ────────────────────────────────────────────────────────────────────────

  private dispatching = false;

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    const text = this.dispatchInput.value.trim();
    const attachment = this.pendingAttachment;
    const images = this.pendingImages.slice();
    if (text.length < 2 && !attachment && images.length === 0) return;

    this.dispatching = true;
    this.dispatchInput.value = '';
    this.pendingAttachment = null;
    this.pendingImages = [];
    this.renderDispatchChips();

    try {
      // Build the full message body, wrapping any file attachment in a code fence
      let messageText = buildMessageWithAttachment(text, attachment);

      // Resolve @[[basename]] file mentions — append each file's content as context
      const mentionRegex = /@\[\[([^\]]+)\]\]/g;
      const mentions = [...messageText.matchAll(mentionRegex)].map(m => m[1]);
      if (mentions.length > 0) {
        const fileContextParts: string[] = [];
        for (const basename of mentions) {
          const file = this.app.vault.getMarkdownFiles().find(f => f.basename === basename);
          if (file) {
            try {
              const content = await this.app.vault.cachedRead(file);
              fileContextParts.push(`**File: ${file.path}**\n\`\`\`\n${content}\n\`\`\``);
            } catch {
              // Skip unreadable files
            }
          }
        }
        if (fileContextParts.length > 0) {
          messageText = messageText + '\n\n---\nReferenced files:\n\n' + fileContextParts.join('\n\n');
        }
      }

      // Derive a readable title: prefer typed text, then attachment filename, then images
      const titleHint = deriveDispatchTitle(text, attachment, images.length);

      const threadId = await this.plugin.dispatchNewThread(
        messageText,
        images.length > 0 ? images : undefined,
        titleHint,
      );
      await this.plugin.openThreadInChatView(threadId);
      this.render();
    } finally {
      this.dispatching = false;
    }
  }
}


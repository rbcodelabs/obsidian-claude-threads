import { ItemView, WorkspaceLeaf, Modal, Menu, setIcon, setTooltip, Notice, sanitizeHTMLToDom, App } from 'obsidian';
import { marked } from 'marked';
import { MAX_ATTACHMENT_BYTES } from './attachmentUtils';
import type { Thread, ChatMessage, ToolCallRecord, AskQuestion, ImageAttachment, ImageMediaType } from './types';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { SummarizeResult } from './InProcessSummarizer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import type ClaudeThreadsPlugin from './main';
import { isDefaultThreadTitle } from './thread-title-utils';
import { formatToolName, getToolIcon } from './ClaudeSession';
import { SttController } from './stt';

export const VIEW_TYPE = 'claude-threads:chat';

export class ThreadsView extends ItemView {
  private plugin: ClaudeThreadsPlugin;
  private manager: ThreadManager;
  private activeThreadId: string | null = null;
  private streamingEl: HTMLElement | null = null;
  private streamingContentEl: HTMLElement | null = null;
  private streamingContent = '';
  private streamingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  // DOM refs
  private rootEl!: HTMLElement;
  private tabBar!: HTMLElement;
  private titleEl!: HTMLButtonElement;
  private titleTextEl!: HTMLSpanElement;
  private threadInfoBar!: HTMLElement;
  private mainEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private inputRowEl!: HTMLElement;
  private pasteChipsEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private moreBtn!: HTMLButtonElement;
  private statusBar!: HTMLElement;
  private editedFilesEl!: HTMLElement;
  private cwdChipEl!: HTMLElement;
  private cwdChipNameEl!: HTMLElement;

  // Files edited in the active thread (rebuilt on thread switch, updated live)
  private editedFilesSet: Set<string> = new Set();

  // Pending paste attachments
  private pendingAttachment: string | null = null;
  private pendingImages: ImageAttachment[] = [];

  // Debounce timer for persisting per-thread drafts to settings
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Active subagent task pills: taskId → pill element
  private taskPills: Map<string, HTMLElement> = new Map();

  // The user-message bubble we just inserted, so we can remove it on interrupt
  private pendingUserEl: HTMLElement | null = null;

  // The raw typed text from the last send per thread, so we can restore it on interrupt.
  // Keyed by thread ID so switching between threads doesn't cross-contaminate drafts.
  private lastSentTexts: Map<string, string> = new Map();

  // Inline permission cards waiting for user response (threadId -> card state)
  private pendingPermissions: Map<string, {
    toolName: string;
    detail: string;
    resolve: (allow: boolean) => void;
    cardEl: HTMLElement | null;
  }> = new Map();

  // Context footer (status line below input)
  private contextFooterEl!: HTMLElement;
  private statusLineRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly STATUS_LINE_INTERVAL_MS = 30_000;

  // Project indicator pill (near input)
  private projectIndicatorEl!: HTMLElement;

  // Project filtering
  private activeProjectId: string | null = null;
  private projectBar!: HTMLElement;

  // Slash command autocomplete
  // New-thread button
  private newThreadBtn!: HTMLButtonElement;
  // Close/archive current thread button
  private closeThreadBtn!: HTMLButtonElement;

  // Thread switcher inline panel
  private switcherPanelEl: HTMLElement | null = null;
  private switcherOutsideHandler: ((e: MouseEvent) => void) | null = null;

  // Summary peek banner (shown on tab reactivation)
  private summaryBannerEl: HTMLElement | null = null;
  private summaryBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BANNER_IDLE_THRESHOLD_MS = 60_000;  // show only after 1 min away
  private static readonly BANNER_AUTO_DISMISS_MS   = 10_000;  // auto-hide after 10 sec

  // Per-thread streaming buffers. Accumulates tokens and tool calls for every
  // running thread (active or background) so the streaming UI can be fully
  // restored when the user switches back to a thread that is still in progress.
  // Cleared on 'message' or 'done' for the corresponding thread.
  private streamingBuffers: Map<string, { content: string; tools: ToolCallRecord[] }> = new Map();

  private skills: { name: string; description: string }[] = [];
  private skillDropdown: HTMLElement | null = null;
  private skillDropdownItems: { name: string; description: string }[] = [];
  private skillDropdownIndex = 0;

  private fileDropdown: HTMLElement | null = null;
  private fileDropdownItems: { path: string; basename: string; isThis?: boolean }[] = [];
  private fileDropdownIndex = 0;

  // Speech-to-text controller (one per view, shared across mic buttons)
  private sttController: SttController | null = null;

  // ResizeObserver for the floating input panel (keeps --ct-panel-height current)
  private panelResizeObserver: ResizeObserver | null = null;

  private static readonly BUILTIN_COMMANDS: { name: string; description: string }[] = [
    { name: 'compact', description: 'Summarize conversation history to free up context' },
    { name: 'clear', description: 'Clear conversation history and start fresh' },
    { name: 'cost', description: 'Show token usage and cost for this session' },
    { name: 'model', description: 'Set persistent model: /model opus|sonnet|haiku|default' },
  ];

  private static readonly MODEL_ALIASES: Record<string, string | undefined> = {
    opus: 'opus',
    sonnet: 'sonnet',
    haiku: 'haiku',
    default: undefined,
    reset: undefined,
  };

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeThreadsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.manager = plugin.manager;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    if (this.activeThreadId) {
      const thread = this.manager.getThread(this.activeThreadId);
      if (thread) return thread.title;
    }
    return 'Claude Threads';
  }

  /** Force Obsidian to re-read getDisplayText() and repaint the workspace tab header. */
  private refreshLeafHeader(): void {
    (this.leaf as any).updateHeader();
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    this.buildUI();

    this.manager.permissionHandler = (threadId, toolName, detail) => {
      // First-party Obsidian MCP tools are always trusted — no prompt needed.
      if (toolName.startsWith('obsidian_')) return Promise.resolve(true);
      if (this.plugin.settings.alwaysAllowedTools.includes(toolName)) return Promise.resolve(true);

      return new Promise((resolve) => {
        let resolved = false;
        const done = (allow: boolean) => {
          if (resolved) return;
          resolved = true;
          const pending = this.pendingPermissions.get(threadId);
          if (pending?.cardEl) pending.cardEl.remove();
          this.pendingPermissions.delete(threadId);
          resolve(allow);
        };

        // Register with ThreadManager so AgentDashboard can also resolve this
        this.manager.registerPermissionResolver(threadId, done);

        // Render card immediately if this is the active thread; otherwise store for later
        if (threadId === this.activeThreadId) {
          const cardEl = this.renderPermissionCard(toolName, detail, done);
          this.pendingPermissions.set(threadId, { toolName, detail, resolve: done, cardEl });
          this.scrollToBottom();
        } else {
          this.pendingPermissions.set(threadId, { toolName, detail, resolve: done, cardEl: null });
        }
      });
    };

    this.manager.questionHandler = (questions: AskQuestion[]) =>
      new Promise((resolve) => {
        const answers: Record<string, string[]> = {};
        for (const q of questions) answers[q.question] = [];

        const modal = new Modal(this.app);
        modal.titleEl.setText('Claude needs your input');
        modal.contentEl.addClass('ct-question-modal');

        for (const q of questions) {
          const qEl = modal.contentEl.createDiv({ cls: 'ct-question' });
          if (q.header) qEl.createEl('h3', { cls: 'ct-question-header', text: q.header });
          qEl.createEl('p', { cls: 'ct-question-text', text: q.question });

          const optionsEl = qEl.createDiv({ cls: 'ct-question-options' });
          for (const opt of q.options) {
            const row = optionsEl.createDiv({ cls: 'ct-question-option' });
            const inputEl = row.createEl('input', {
              attr: { type: q.multiSelect ? 'checkbox' : 'radio', name: q.question, value: opt.label },
            });
            const labelEl = row.createEl('label', { cls: 'ct-question-option-label' });
            labelEl.createSpan({ cls: 'ct-question-opt-name', text: opt.label });
            if (opt.description) {
              labelEl.createSpan({ cls: 'ct-question-opt-desc', text: opt.description });
            }
            inputEl.addEventListener('change', () => {
              if (q.multiSelect) {
                if ((inputEl as HTMLInputElement).checked) answers[q.question].push(opt.label);
                else answers[q.question] = answers[q.question].filter(v => v !== opt.label);
              } else {
                answers[q.question] = [opt.label];
              }
            });
          }
        }

        const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' });
        const submit = btnRow.createEl('button', { text: 'Submit', cls: 'mod-cta' });
        submit.onclick = () => {
          const result: Record<string, string> = {};
          for (const [q, vals] of Object.entries(answers)) result[q] = vals.join(',');
          resolve(result);
          modal.close();
        };

        modal.onClose = () => {
          const result: Record<string, string> = {};
          for (const [q, vals] of Object.entries(answers)) result[q] = vals.join(',');
          resolve(result);
        };

        modal.open();
      });

    this.manager.openNewTabHandler = async (title?: string, initialPrompt?: string) => {
      let cwd = this.plugin.getEffectiveCwd();
      let projectId: string | undefined;
      if (this.activeProjectId) {
        const project = this.manager.getProject(this.activeProjectId);
        if (project) { cwd = this.manager.getProjectCwd(project); projectId = project.id; }
      }
      const thread = this.manager.createThread(title ?? `Thread ${this.manager.getThreads().length + 1}`, cwd, projectId);
      await this.plugin.saveSettings();
      this.renderProjectBar();
      this.setActiveThread(thread.id);
      if (initialPrompt) {
        this.inputEl.value = initialPrompt;
      }
      return { threadId: thread.id, title: thread.title };
    };

    this.unsubscribe = this.manager.subscribe((threadId, event) => {
      // Save whenever any thread's persistent state changes, not just the active one.
      // Without this, messages on background threads are never written to disk and
      // are lost on reload.
      if (event.type === 'message' || event.type === 'done' || event.type === 'compact') {
        void this.plugin.saveSettings();
      }
      // Keep project badge counts up to date
      if (event.type === 'thread_created' || event.type === 'thread_deleted') {
        this.renderProjectBar();
      }
      // Maintain a per-thread streaming buffer for ALL threads so we can restore
      // the live streaming UI when switching back to a thread still in progress.
      if (event.type === 'streaming_start') {
        this.streamingBuffers.set(threadId, { content: '', tools: [] });
      } else if (event.type === 'token') {
        let buf = this.streamingBuffers.get(threadId);
        if (!buf) { buf = { content: '', tools: [] }; this.streamingBuffers.set(threadId, buf); }
        buf.content += event.text;
      } else if (event.type === 'tool_use') {
        let buf = this.streamingBuffers.get(threadId);
        if (!buf) { buf = { content: '', tools: [] }; this.streamingBuffers.set(threadId, buf); }
        buf.tools.push(event.record);
      } else if (event.type === 'message' || event.type === 'done') {
        this.streamingBuffers.delete(threadId);
      }
      if (threadId === this.activeThreadId) {
        this.handleEvent(event);
      }
    });

    const threads = this.manager.getThreads();
    if (threads.length > 0) {
      // Respect a pre-set activeThreadId (e.g. focusThread called before buildUI in a race),
      // otherwise default to the most recently created thread rather than the oldest.
      const targetId = (this.activeThreadId && this.manager.getThread(this.activeThreadId))
        ? this.activeThreadId
        : threads[threads.length - 1].id;
      this.setActiveThread(targetId);
    } else {
      const thread = this.manager.createThread('Thread 1', this.plugin.getEffectiveCwd());
      await this.plugin.saveSettings();
      this.setActiveThread(thread.id);
    }

    this.renderProjectBar();
    this.renderTitleBar();

    // Start periodic status line refresh
    this.startStatusLineInterval();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.stopStatusLineInterval();
    this.sttController?.destroy();
    this.panelResizeObserver?.disconnect();
    this.panelResizeObserver = null;
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    this.rootEl = root;
    root.empty();
    root.addClass('ct-root');
    root.setAttribute('data-density', this.plugin.settings.layoutDensity ?? 'comfortable');

    const titleRow = root.createDiv('ct-title-row');
    this.titleEl = titleRow.createEl('button', { cls: 'ct-title-btn', attr: { title: 'Switch thread' } });
    const titleIcon = this.titleEl.createSpan('ct-title-icon');
    setIcon(titleIcon, 'message-square');
    this.titleTextEl = this.titleEl.createSpan({ cls: 'ct-title-text', text: 'Claude Threads' });
    const chevronEl = this.titleEl.createSpan('ct-title-chevron');
    setIcon(chevronEl, 'chevron-down');
    this.titleEl.addEventListener('click', (e) => this.openThreadSwitcher(e));
    this.titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (this.activeThreadId) this.renameThread(this.activeThreadId, this.titleTextEl);
    });
    this.newThreadBtn = titleRow.createEl('button', { cls: 'ct-tab-new', attr: { title: 'New thread' } });
    setIcon(this.newThreadBtn, 'square-pen');
    this.newThreadBtn.addEventListener('click', (e) => this.openNewThread(e));
    this.closeThreadBtn = titleRow.createEl('button', { cls: 'ct-title-close', attr: { title: 'Close thread' } });
    setIcon(this.closeThreadBtn, 'x');
    this.closeThreadBtn.addEventListener('click', () => {
      if (this.activeThreadId) this.closeThread(this.activeThreadId);
    });
    this.threadInfoBar = root.createDiv('ct-thread-info-bar');

    this.mainEl = root.createDiv('ct-main');
    this.messagesEl = this.mainEl.createDiv('ct-messages');

    const floatingPanel = this.mainEl.createDiv('ct-floating-panel');
    const panelContext = floatingPanel.createDiv('ct-panel-context');

    this.statusBar = panelContext.createDiv('ct-status-bar');
    this.editedFilesEl = panelContext.createDiv('ct-edited-files ct-hidden');

    this.inputRowEl = floatingPanel.createDiv('ct-input-row');
    this.pasteChipsEl = this.inputRowEl.createDiv('ct-paste-chips ct-hidden');

    const inputControls = this.inputRowEl.createDiv('ct-input-controls');

    this.loadSkills();
    this.inputEl = inputControls.createEl('textarea', {
      cls: 'ct-input',
      attr: { placeholder: 'Message Claude... (Enter to send, Shift+Enter for newline)' },
    });
    const inputActions = inputControls.createDiv('ct-input-actions');
    this.sendBtn = inputActions.createEl('button', { cls: 'ct-send-btn', text: '↵', attr: { title: 'Send message' } });
    this.stopBtn = inputActions.createEl('button', {
      cls: 'ct-stop-btn ct-hidden',
      text: '■',
      attr: { title: 'Stop' },
    });

    // Secondary actions live in a footer row below the textarea
    const inputFooter = this.inputRowEl.createDiv('ct-input-footer');

    // CWD chip — always visible, left-aligned in the footer
    this.cwdChipEl = inputFooter.createDiv({ cls: 'ct-edited-file-chip ct-edited-files-cwd ct-footer-cwd' });
    const cwdFooterIcon = this.cwdChipEl.createSpan('ct-edited-file-chip-icon');
    setIcon(cwdFooterIcon, 'folder');
    this.cwdChipNameEl = this.cwdChipEl.createSpan({ cls: 'ct-edited-file-chip-name' });

    // Right-side buttons group (menu + mic)
    const footerActions = inputFooter.createDiv('ct-input-footer-actions');
    this.moreBtn = footerActions.createEl('button', {
      cls: 'ct-more-btn',
      attr: { title: 'More actions' },
    });
    setIcon(this.moreBtn, 'menu');
    this.moreBtn.addEventListener('click', (e) => this.toggleMoreMenu(e));

    this.inputEl.addEventListener('keydown', (e) => {
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
          const selectedItem = this.fileDropdownItems[this.fileDropdownIndex];
          if (selectedItem.isThis) {
            this.insertThisMention();
          } else {
            this.insertFileMention(selectedItem.basename);
          }
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
      if (e.key === 'Escape' && !this.stopBtn.hasClass('ct-hidden')) {
        e.preventDefault();
        this.stopMessage();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.inputEl.addEventListener('input', () => {
      const atQuery = this.getAtQuery();
      if (atQuery !== null) {
        this.hideSkillDropdown();
        this.showFileDropdown(atQuery);
        this.scheduleDraftSave();
        return;
      }
      this.hideFileDropdown();
      const query = this.getSlashQuery();
      if (query !== null) this.showSkillDropdown(query);
      else this.hideSkillDropdown();
      this.scheduleDraftSave();
    });
    this.inputEl.addEventListener('blur', () => {
      setTimeout(() => {
        this.hideSkillDropdown();
        this.hideFileDropdown();
      }, 150);
    });
    this.inputEl.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      const imageFiles = files.filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        e.preventDefault();
        imageFiles.forEach(f => this.addImageAttachment(f));
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text.length >= 500) {
        e.preventDefault();
        this.addPasteAttachment(text);
      }
    });
    this.inputRowEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.inputRowEl.addClass('ct-drag-over');
    });
    this.inputRowEl.addEventListener('dragleave', (e) => {
      if (!this.inputRowEl.contains(e.relatedTarget as Node | null)) {
        this.inputRowEl.removeClass('ct-drag-over');
      }
    });
    this.inputRowEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.inputRowEl.removeClass('ct-drag-over');
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          this.addImageAttachment(file);
        } else {
          this.addFileAsTextAttachment(file);
        }
      }
    });
    this.sendBtn.addEventListener('click', () => this.sendMessage());
    this.stopBtn.addEventListener('click', () => this.stopMessage());

    // Mic button for speech-to-text — lives in the footer actions group alongside more-btn
    this.sttController = new SttController(this.app);
    const micBtn = this.sttController.createMicButton(this.inputEl);
    footerActions.appendChild(micBtn);

    this.projectIndicatorEl = this.inputRowEl.createDiv('ct-project-indicator ct-hidden');

    this.contextFooterEl = panelContext.createDiv('ct-context-footer ct-hidden');

    // Keep messages scroll clearance in sync with the floating panel height
    this.panelResizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const height = entry.contentRect.height;
        // +16 = 8px bottom offset + 8px breathing room above the panel
        this.messagesEl.style.setProperty('--ct-panel-height', `${height + 16}px`);
      }
    });
    this.panelResizeObserver.observe(floatingPanel);
  }

  private renderProjectBar(): void {
    if (!this.projectBar) return; // project bar removed from UI; kept for compat
    this.projectBar.empty();
    const projects = this.manager.getProjects();

    // "All" pill
    const allPill = this.projectBar.createEl('button', {
      cls: `ct-project-pill ${this.activeProjectId === null ? 'ct-project-pill-active' : ''}`,
      text: 'All',
    });
    allPill.addEventListener('click', () => {
      this.activeProjectId = null;
      this.renderProjectBar();
      this.renderTitleBar();
    });

    for (const project of projects) {
      const pill = this.projectBar.createEl('button', {
        cls: `ct-project-pill ${this.activeProjectId === project.id ? 'ct-project-pill-active' : ''}`,
      });
      pill.createSpan({ cls: 'ct-project-pill-icon', text: '📁' });
      pill.createSpan({ cls: 'ct-project-pill-name', text: project.name });

      const threadCount = this.manager.getThreadsByProject(project.id).length;
      if (threadCount > 0) {
        pill.createSpan({ cls: 'ct-project-pill-count', text: String(threadCount) });
      }

      pill.setAttribute('title', project.vaultFolder + (project.description ? '\n' + project.description : ''));

      pill.addEventListener('click', () => {
        this.activeProjectId = project.id;
        this.renderProjectBar();
        this.renderTitleBar();
        // If the current active thread isn't in this project, switch to first project thread
        const currentThread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
        if (!currentThread || currentThread.projectId !== project.id) {
          const projectThreads = this.manager.getThreadsByProject(project.id);
          if (projectThreads.length > 0) {
            this.setActiveThread(projectThreads[0].id);
          }
        }
      });
    }

    // Only show the bar if there are projects
    if (projects.length === 0) {
      this.projectBar.addClass('ct-hidden');
    } else {
      this.projectBar.removeClass('ct-hidden');
    }
  }

  private renderTitleBar(): void {
    if (!this.titleTextEl) return;
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    this.titleTextEl.textContent = thread?.title ?? 'Claude Threads';

    const threads = this.manager.getThreads();
    const hasRunning = threads.some(t => t.id !== this.activeThreadId && this.manager.isRunning(t.id));
    this.titleEl.classList.toggle('ct-title-has-background', hasRunning);

    // Hide close button when there is only one thread (nothing to switch to)
    if (this.closeThreadBtn) {
      this.closeThreadBtn.classList.toggle('ct-hidden', threads.length <= 1);
    }
  }


  focusThread(id: string): void {
    this.setActiveThread(id);
  }

  /** Update the density data-attribute live when the user changes the setting. */
  applyDensity(): void {
    if (this.rootEl) {
      this.rootEl.setAttribute('data-density', this.plugin.settings.layoutDensity ?? 'comfortable');
    }
  }


  getActiveThreadId(): string | null {
    return this.activeThreadId;
  }

  /** Snapshot the current input box state into the given thread object. */
  private saveDraftToThread(threadId: string | null): void {
    if (!threadId || !this.inputEl) return;
    const thread = this.manager.getThread(threadId);
    if (!thread) return;
    const text = this.inputEl.value;
    const hasContent = text.length > 0 || this.pendingAttachment !== null || this.pendingImages.length > 0;
    if (hasContent) {
      thread.draft = { text, attachment: this.pendingAttachment, images: [...this.pendingImages] };
    } else {
      delete thread.draft;
    }
  }

  /** Restore the input box state from a thread's saved draft (or clear it). */
  private restoreDraftFromThread(threadId: string): void {
    if (!this.inputEl) return;
    const thread = this.manager.getThread(threadId);
    const draft = thread?.draft;
    this.inputEl.value = draft?.text ?? '';
    this.pendingAttachment = draft?.attachment ?? null;
    this.pendingImages = draft ? [...draft.images] : [];
    this.renderPasteChips();
  }

  /**
   * Debounce-save the active thread's draft to plugin settings so it survives
   * a plugin reload. Fires 1.5 s after the last keystroke or attachment change.
   */
  private scheduleDraftSave(): void {
    if (this.draftSaveTimer !== null) clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => {
      this.draftSaveTimer = null;
      this.saveDraftToThread(this.activeThreadId);
      this.plugin.saveSettings();
    }, 1500);
  }

  private setActiveThread(id: string): void {
    this.closeSwitcherPanel();
    const previousId = this.activeThreadId;

    // Mark the thread as reviewed when the user explicitly opens it.
    // This covers all entry paths: switcher dropdown clicks, focusThread()
    // calls (including programmatic callers like obsidian-voice), keyboard
    // navigation, and openThreadInChatView().
    const threadToReview = this.manager.getThread(id);
    if (threadToReview && !threadToReview.reviewed) {
      threadToReview.reviewed = true;
      this.plugin.saveSettings();
    }

    // Persist the draft for the thread we're leaving before switching
    this.saveDraftToThread(this.activeThreadId);
    this.activeThreadId = id;
    if (!this.titleEl) return; // buildUI hasn't run yet; onOpen will call us again with the right id
    this.manager.notifyActiveThreadChanged(id);
    this.renderTitleBar();
    this.renderThreadInfo();
    this.renderMessages();
    this.setRunningState(this.manager.isRunning(id));
    this.updateProjectIndicator();
    this.syncEditedFiles();
    this.refreshLeafHeader();
    // Restore draft for the thread we just switched to
    this.restoreDraftFromThread(id);
    // Refresh context footer for the new thread's cwd
    void this.refreshStatusLine();

    // Show the context recap banner when switching back to a thread after being away
    this.maybeShowSummaryBanner(id, previousId, undefined);
  }

  // ---------------------------------------------------------------------------
  // Summary peek banner
  // ---------------------------------------------------------------------------

  private maybeShowSummaryBanner(
    threadId: string,
    previousId: string | null,
    priorAccessTime: number | undefined,
  ): void {
    this.hideSummaryBanner(true); // clear any stale banner immediately

    // Only fire when genuinely switching between two different threads
    if (!previousId || previousId === threadId) return;

    const thread = this.manager.getThread(threadId);
    if (!thread) return;

    const summary = thread.summary || thread.recap;
    if (!summary) return;

    // Skip if the user was just here — only show when returning after a real break
    const elapsed = priorAccessTime !== undefined ? Date.now() - priorAccessTime : Infinity;
    if (elapsed < ThreadsView.BANNER_IDLE_THRESHOLD_MS) return;

    this.showSummaryBanner(thread, summary);
  }

  private showSummaryBanner(thread: Thread, summary: string): void {
    const banner = this.mainEl.createDiv('ct-summary-banner');
    this.summaryBannerEl = banner;

    const header = banner.createDiv('ct-summary-banner-header');
    header.createSpan({ cls: 'ct-summary-banner-label', text: '↺ Context' });
    header.createSpan({
      cls: 'ct-summary-banner-time',
      text: `Last active ${this.formatTimeAgo(thread.updatedAt)}`,
    });

    const closeBtn = header.createEl('button', {
      cls: 'ct-summary-banner-close',
      text: '×',
      attr: { title: 'Dismiss' },
    });
    closeBtn.addEventListener('click', () => this.hideSummaryBanner(false));

    banner.createEl('p', { cls: 'ct-summary-banner-text', text: summary });

    // Auto-dismiss after the configured delay
    this.summaryBannerTimer = setTimeout(
      () => this.hideSummaryBanner(false),
      ThreadsView.BANNER_AUTO_DISMISS_MS,
    );
  }

  private hideSummaryBanner(immediate: boolean): void {
    if (this.summaryBannerTimer !== null) {
      clearTimeout(this.summaryBannerTimer);
      this.summaryBannerTimer = null;
    }
    if (!this.summaryBannerEl) return;
    const el = this.summaryBannerEl;
    this.summaryBannerEl = null;

    if (immediate) {
      el.remove();
      return;
    }

    // Animate out then remove
    el.addClass('ct-summary-banner-out');
    setTimeout(() => el.remove(), 300);
  }

  private formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }

  /** Formats a UNIX-ms timestamp as a short wall-clock time, e.g. "3:45 PM".
   *  If the timestamp is from a different calendar day, prefixes the date: "May 27, 3:45 PM". */
  private formatShortTime(timestamp: number): string {
    const d = new Date(timestamp);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return time;
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${date}, ${time}`;
  }

  // ---------------------------------------------------------------------------
  // Context footer (status line)
  // ---------------------------------------------------------------------------

  private startStatusLineInterval(): void {
    this.stopStatusLineInterval();
    const cmd = this.plugin.settings.statusLineCommand;
    if (!cmd) return;
    this.statusLineRefreshTimer = setInterval(
      () => void this.refreshStatusLine(),
      ThreadsView.STATUS_LINE_INTERVAL_MS,
    );
  }

  private stopStatusLineInterval(): void {
    if (this.statusLineRefreshTimer !== null) {
      clearInterval(this.statusLineRefreshTimer);
      this.statusLineRefreshTimer = null;
    }
  }

  /**
   * Run the configured statusLineCommand, pipe the active thread's cwd as JSON
   * to stdin, and render the stdout output in the context footer bar.
   * Silently hides the footer on error or empty output.
   */
  refreshStatusLine(): void {
    const cmd = this.plugin.settings.statusLineCommand;
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;

    // Lazy-scan existing threads for a PR URL in case it was created before
    // the prUrl field was introduced (scans the last 20 messages for a GitHub PR link).
    if (thread && !thread.prUrl) {
      const msgs = thread.messages.slice(-20);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant') {
          const match = m.content.match(/https:\/\/github\.com\/[^\s>)"']+\/pull\/\d+/);
          if (match) { thread.prUrl = match[0]; break; }
        }
      }
    }

    const prUrl = thread?.prUrl;

    if (!cmd) {
      if (prUrl) {
        this.renderContextFooter('', prUrl);
      } else {
        this.contextFooterEl.addClass('ct-hidden');
      }
      return;
    }

    const cwd = thread?.cwd || this.plugin.getEffectiveCwd() || os.homedir();
    const stdin = JSON.stringify({ cwd, workspace: { current_dir: cwd } });

    // Expand $HOME / ~ in the command so paths work outside a login shell
    const expandedCmd = cmd.replace(/\$HOME/g, os.homedir()).replace(/^~\//, `${os.homedir()}/`);

    const child = exec(
      expandedCmd,
      { env: { ...process.env, HOME: os.homedir() }, timeout: 5000 },
      (err, stdout) => {
        const text = stdout.trim();
        if (err || !text) {
          if (prUrl) {
            this.renderContextFooter('', prUrl);
          } else {
            this.contextFooterEl.addClass('ct-hidden');
          }
          return;
        }
        this.renderContextFooter(text, prUrl);
      },
    );

    child.stdin?.write(stdin);
    child.stdin?.end();
  }

  private renderContextFooter(shellText: string, prUrl?: string): void {
    this.contextFooterEl.empty();

    // PR pill — always rendered first when the thread has an associated PR.
    if (prUrl) {
      const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
      const label = prNumMatch ? `PR #${prNumMatch[1]}` : 'Open PR';
      const pill = this.contextFooterEl.createDiv('ct-footer-pill ct-footer-pill-pr');
      const iconEl = pill.createSpan('ct-footer-pill-icon');
      setIcon(iconEl, 'git-pull-request');
      const link = pill.createEl('a', { cls: 'ct-footer-pill-text ct-footer-link', text: label });
      link.href = prUrl;
      link.title = prUrl;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const { shell } = require('electron') as { shell: { openExternal: (url: string) => void } };
        shell.openExternal(prUrl);
      });
    }

    // Shell-command pills — split on two-or-more spaces, each segment is a pill.
    const segments = shellText.split(/  +/).map(s => s.trim()).filter(Boolean);

    for (const segment of segments) {
      const pill = this.contextFooterEl.createDiv('ct-footer-pill');

      // Heuristic decoration: URL gets a globe icon, branch gets git-branch,
      // "PR #N" gets a pull-request marker, AWS status gets a cloud icon.
      if (/^https?:\/\//.test(segment)) {
        const iconEl = pill.createSpan('ct-footer-pill-icon');
        setIcon(iconEl, 'globe');
        const link = pill.createEl('a', { cls: 'ct-footer-pill-text ct-footer-link', text: segment });
        link.href = segment;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const { shell } = require('electron') as { shell: { openExternal: (url: string) => void } };
          shell.openExternal(segment);
        });
      } else if (/^PR #\d+/.test(segment)) {
        const iconEl = pill.createSpan('ct-footer-pill-icon');
        setIcon(iconEl, 'git-pull-request');
        pill.createSpan({ cls: 'ct-footer-pill-text', text: segment });
      } else if (/AWS/.test(segment)) {
        const iconEl = pill.createSpan('ct-footer-pill-icon');
        setIcon(iconEl, segment.includes('ok') ? 'cloud' : 'cloud-off');
        pill.createSpan({
          cls: `ct-footer-pill-text ${segment.includes('expired') ? 'ct-footer-pill-warn' : ''}`,
          text: segment,
        });
      } else {
        // Default: treat as git branch name
        const iconEl = pill.createSpan('ct-footer-pill-icon');
        setIcon(iconEl, 'git-branch');
        pill.createSpan({ cls: 'ct-footer-pill-text', text: segment });
      }
    }

    if (!prUrl && segments.length === 0) {
      this.contextFooterEl.addClass('ct-hidden');
    } else {
      this.contextFooterEl.removeClass('ct-hidden');
    }
  }

  /** Called from settings tab when the command is changed so the footer updates live. */
  updateStatusLineCommand(): void {
    this.stopStatusLineInterval();
    this.startStatusLineInterval();
    void this.refreshStatusLine();
  }

  /** Rebuild the edited-files set from saved thread state for the active thread. */
  private syncEditedFiles(): void {
    this.editedFilesSet.clear();
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    if (thread) {
      if (thread.editedFiles && thread.editedFiles.length > 0) {
        // Preferred path: dedicated field populated by ThreadManager on every tool use.
        for (const filePath of thread.editedFiles) {
          this.editedFilesSet.add(filePath);
        }
      } else {
        // Fallback for older threads that were saved before editedFiles was introduced.
        for (const msg of thread.messages) {
          for (const tool of msg.toolCalls ?? []) {
            if (tool.name === 'Write' || tool.name === 'Edit') {
              const filePath = tool.summary.replace(/^[^:]+: /, '');
              if (filePath) this.editedFilesSet.add(filePath);
            }
          }
        }
      }
    }
    this.renderEditedFilesCard();
  }

  // Switch to icon-only chips above this file count to keep the row compact
  private static readonly COMPACT_THRESHOLD = 8;

  /** Render (or hide) the edited-files card below the chat area. */
  private renderEditedFilesCard(): void {
    this.editedFilesEl.empty();
    if (this.editedFilesSet.size === 0) {
      this.editedFilesEl.addClass('ct-hidden');
      return;
    }
    this.editedFilesEl.removeClass('ct-hidden');

    const iconOnly = this.editedFilesSet.size > ThreadsView.COMPACT_THRESHOLD;
    const list = this.editedFilesEl.createDiv('ct-edited-files-list');

    // Vault files first (most-recently-edited within each group), then non-vault files.
    const adapter = this.app.vault.adapter as { basePath?: string };
    const vaultBase = adapter.basePath ?? '';
    const reversed = [...this.editedFilesSet].reverse();
    const vaultFiles = reversed.filter(f => vaultBase && f.startsWith(vaultBase + path.sep));
    const nonVaultFiles = reversed.filter(f => !vaultBase || !f.startsWith(vaultBase + path.sep));
    const files = [...vaultFiles, ...nonVaultFiles];
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const showFull = !iconOnly || i < 3;
      const chip = list.createDiv({
        cls: showFull ? 'ct-edited-file-chip' : 'ct-edited-file-chip ct-edited-file-chip--icon-only',
      });
      const fileIcon = chip.createSpan('ct-edited-file-chip-icon');
      setIcon(fileIcon, 'file-edit');
      if (showFull) {
        chip.createSpan({ cls: 'ct-edited-file-chip-name', text: path.basename(filePath) });
      } else {
        setTooltip(chip, path.basename(filePath));
      }
      chip.addEventListener('click', () => this.openEditedFile(filePath));
    }

    // Focus button as a small icon chip at the end of the list
    const focusChip = list.createDiv({ cls: 'ct-edited-file-chip ct-focus-files-chip', attr: { title: 'Open only these files (close other tabs)' } });
    setTooltip(focusChip, 'Open only these files');
    const focusIcon = focusChip.createSpan('ct-edited-file-chip-icon');
    setIcon(focusIcon, 'focus');
    focusChip.addEventListener('click', (e) => { e.stopPropagation(); this.focusEditedFiles(); });
  }

  /** Close all markdown tabs and reopen only the files edited in this thread. */
  private async focusEditedFiles(): Promise<void> {
    const workspace = this.app.workspace;
    const adapter = this.app.vault.adapter as { basePath?: string };
    const vaultBase = adapter.basePath ?? '';

    const relPaths: string[] = [];
    for (const filePath of this.editedFilesSet) {
      if (vaultBase && filePath.startsWith(vaultBase + path.sep)) {
        relPaths.push(filePath.slice(vaultBase.length + 1));
      }
    }

    if (relPaths.length === 0) {
      new Notice('No vault files to focus.');
      return;
    }

    // Close all existing markdown leaves
    const leavesToDetach: any[] = [];
    workspace.iterateAllLeaves((leaf: any) => {
      if (leaf.view?.getViewType() === 'markdown') leavesToDetach.push(leaf);
    });
    for (const leaf of leavesToDetach) leaf.detach();

    // Open each file in a new tab
    for (let i = 0; i < relPaths.length; i++) {
      const file = this.app.vault.getAbstractFileByPath(relPaths[i]);
      if (!file) continue;
      const leaf = workspace.getLeaf(i === 0 ? false : 'tab');
      await (leaf as any).openFile(file);
    }

    new Notice(`Focused ${relPaths.length} file${relPaths.length === 1 ? '' : 's'}`);
  }

  /** Open a file path — vault files open inside Obsidian, others via the OS. */
  private async openEditedFile(filePath: string): Promise<void> {
    try {
      const adapter = this.app.vault.adapter as { basePath?: string };
      const vaultBase = adapter.basePath ?? '';
      if (vaultBase && filePath.startsWith(vaultBase + path.sep)) {
        const rel = filePath.slice(vaultBase.length + 1);
        const file = this.app.vault.getAbstractFileByPath(rel);
        if (file) {
          const leaf = this.app.workspace.getLeaf(false);
          await (leaf as any).openFile(file);
          return;
        }
      }
      // Non-vault file — open with the OS default application
      const { shell } = require('electron') as { shell: { openPath: (p: string) => Promise<string> } };
      await shell.openPath(filePath);
    } catch (err) {
      new Notice(`Could not open file: ${(err as Error).message}`);
    }
  }

  private updateProjectIndicator(): void {
    this.projectIndicatorEl.empty();
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    const project = thread?.projectId ? this.manager.getProject(thread.projectId) : null;
    if (project) {
      this.projectIndicatorEl.removeClass('ct-hidden');
      this.projectIndicatorEl.createSpan({ cls: 'ct-project-indicator-icon', text: '📁' });
      this.projectIndicatorEl.createSpan({ cls: 'ct-project-indicator-name', text: project.name });
    } else {
      this.projectIndicatorEl.addClass('ct-hidden');
    }
  }

  private renderCwdChip(): void {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    const cwd = thread?.cwd || this.plugin.getEffectiveCwd() || os.homedir();
    this.cwdChipNameEl.textContent = shortenPath(cwd);
    setTooltip(this.cwdChipEl, cwd);
  }

  private renderThreadInfo(): void {
    this.threadInfoBar.empty();
    if (!this.activeThreadId) return;
    const thread = this.manager.getThread(this.activeThreadId);
    if (!thread) return;

    this.renderCwdChip();

    // Show model badge only; cwd is now shown in the footer row
    const hasContent = !!thread.model;

    // Hide the bar entirely when there's nothing to show
    this.threadInfoBar.classList.toggle('ct-hidden', !hasContent);

    if (thread.model) {
      this.threadInfoBar.createSpan({ cls: 'ct-model-badge', text: thread.model });
    }
  }

  private toggleMoreMenu(event: MouseEvent): void {
    const thread = this.activeThreadId ? this.manager.getThread(this.activeThreadId) : null;
    if (!thread) return;

    const menu = new Menu();
    menu.addItem(item =>
      item
        .setTitle('Summarize thread')
        .setIcon('brain-circuit')
        .onClick(() => this.summarizeThread(thread.id))
    );
    menu.addItem(item =>
      item
        .setTitle('Fork conversation')
        .setIcon('git-branch')
        .onClick(() => this.forkThread(thread.id))
    );
    menu.showAtMouseEvent(event);
  }

  private async runSummarize(messages: ChatMessage[], onProgress?: (s: string) => void): Promise<SummarizeResult> {
    return this.plugin.inProcessSummarizer.summarize(
      messages,
      this.plugin.settings.claudeBinaryPath,
      this.plugin.settings.inprocessModel,
      this.plugin.settings.extraEnv,
      onProgress,
    );
  }

  async summarizeThread(threadId: string): Promise<void> {
    const thread = this.manager.getThread(threadId);
    if (!thread || thread.messages.length === 0) return;

    this.moreBtn.disabled = true;
    setIcon(this.moreBtn, 'loader');
    this.moreBtn.addClass('ct-summarize-spinning');

    const onProgress = (status: string) => {
      this.statusBar.setText(status);
    };

    try {
      const result = await this.runSummarize(thread.messages, onProgress);
      thread.summary = result.summary;
      // Manual summarize always applies the new title; auto-summarize (after each
      // message) uses applyAutoTitle which guards against overwriting a user-set name.
      if (result.title) this.manager.renameThread(thread.id, result.title);
      await this.plugin.saveSettings();
      this.statusBar.setText('');
      this.moreBtn.removeClass('ct-summarize-spinning');
      setIcon(this.moreBtn, 'menu');
      this.moreBtn.disabled = false;
      this.renderTitleBar();
      this.renderThreadInfo();
      this.refreshLeafHeader();
      // Refresh the Agent Dashboard so the new summary appears there immediately
      this.plugin.getAgentDashboard()?.render();
    } catch (err) {
      console.error('[Claude Threads] summarize error:', err);
      this.statusBar.setText('');
      this.moreBtn.removeClass('ct-summarize-spinning');
      setIcon(this.moreBtn, 'menu');
      this.moreBtn.disabled = false;
      new Notice(`Summarization failed: ${(err as Error).message}`, 8000);
    }
  }

  async forkThread(threadId: string, initialFocus?: string): Promise<void> {
    const thread = this.manager.getThread(threadId);
    if (!thread || thread.messages.filter(m => m.role !== 'compact').length === 0) {
      new Notice('Nothing to fork — thread has no messages yet.');
      return;
    }

    new ForkModal(this.app, this.plugin, thread, async (prompt: string) => {
      const forkedThread = this.manager.createThread(
        `Fork: ${thread.title.slice(0, 40)}`,
        thread.cwd,
        thread.projectId,
      );
      await this.plugin.saveSettings();
      this.setActiveThread(forkedThread.id);
      // Fire-and-forget: switch to the new thread and close the modal immediately
      // without waiting for Claude's response. The first message appears as the
      // thread loads, giving instant feedback instead of a frozen "Opening..." state.
      void this.manager.sendMessage(forkedThread.id, prompt);
    }, initialFocus).open();
  }

  private createStreamingEl(): void {
    this.streamingEl = this.messagesEl.createDiv('ct-message ct-message-assistant ct-streaming');
    this.streamingContentEl = this.streamingEl.createDiv('ct-message-content');
    this.streamingContentEl.createSpan({ cls: 'ct-thinking-label', text: 'Claude is thinking ' });
    this.streamingContentEl.createSpan({ cls: 'ct-cursor' });
  }

  private async renderMessages(): Promise<void> {
    this.messagesEl.empty();
    this.clearStreamingState();
    this.streamingEl = null;

    if (!this.activeThreadId) return;
    const thread = this.manager.getThread(this.activeThreadId);
    if (!thread) return;

    if (thread.messages.length === 0) {
      const empty = this.messagesEl.createDiv('ct-empty');
      const iconEl = empty.createDiv('ct-empty-icon');
      setIcon(iconEl, 'message-square');
      empty.createEl('p', { cls: 'ct-empty-title', text: 'Ask Claude anything' });
      const cwdEl = empty.createDiv('ct-empty-sub');
      const folderIcon = cwdEl.createSpan('ct-empty-sub-icon');
      setIcon(folderIcon, 'folder');
      cwdEl.createSpan({ text: thread.cwd || os.homedir() });
      empty.createEl('p', { cls: 'ct-empty-hint', text: 'Enter to send · Shift+Enter for newline' });
      return;
    }

    for (const msg of thread.messages) {
      await this.appendMessage(msg);
    }

    if (this.manager.isRunning(this.activeThreadId)) {
      this.createStreamingEl();
      // Restore streaming content and tool pills accumulated while this thread
      // was running in the background (user was viewing a different thread).
      const buf = this.streamingBuffers.get(this.activeThreadId!);
      if (buf) {
        // Replay tool pills in the order they originally arrived. prepend()
        // inserts above existing children, so iterate in reverse so the first
        // tool ends up on top (matching the live order).
        for (let i = buf.tools.length - 1; i >= 0; i--) {
          const tool = buf.tools[i];
          const pill = document.createElement('div');
          pill.className = 'ct-tool-pill ct-tool-active';
          const iconEl = document.createElement('span');
          iconEl.className = 'ct-tool-pill-icon';
          setIcon(iconEl, getToolIcon(tool.name));
          const badge = document.createElement('span');
          badge.className = 'ct-tool-pill-name';
          badge.textContent = formatToolName(tool.name);
          pill.append(iconEl, badge);
          if (tool.summary) {
            const label = document.createElement('span');
            label.className = 'ct-tool-pill-text';
            label.textContent = tool.summary;
            pill.append(label);
          }
          this.streamingEl!.prepend(pill);
        }
        // Restore accumulated text and re-render it into the streaming bubble.
        if (buf.content) {
          this.streamingContent = buf.content;
          void this.renderStreamingContent();
        }
      }
    }

    // Re-render any pending permission card that was created while viewing another thread
    const pendingPerm = this.pendingPermissions.get(this.activeThreadId!);
    if (pendingPerm && !pendingPerm.cardEl?.isConnected) {
      const cardEl = this.renderPermissionCard(pendingPerm.toolName, pendingPerm.detail, pendingPerm.resolve);
      pendingPerm.cardEl = cardEl;
    }

    this.scrollToBottom();
    this.setRunningState(this.manager.isRunning(this.activeThreadId));
  }

  private async appendMessage(msg: ChatMessage): Promise<void> {
    if (msg.role === 'compact') {
      const divider = this.messagesEl.createDiv('ct-compact-divider');
      const label = msg.compactTrigger === 'manual' ? 'Context compacted' : 'Context auto-compacted';
      divider.createSpan({ cls: 'ct-compact-label', text: label });
      if (msg.preTokens && msg.preTokens > 0) {
        divider.createSpan({ cls: 'ct-compact-tokens', text: `${(msg.preTokens / 1000).toFixed(0)}k tokens` });
      }
      return;
    }

    const el = this.messagesEl.createDiv(`ct-message ct-message-${msg.role}`);

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      this.renderToolCalls(el, msg.toolCalls);
    }

    const content = el.createDiv('ct-message-content');
    if (msg.role === 'assistant') {
      content.appendChild(sanitizeHTMLToDom(await marked.parse(msg.content)));
      const copyBtn = el.createEl('button', { cls: 'ct-copy-btn', attr: { title: 'Copy response' } });
      setIcon(copyBtn, 'copy');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(msg.content);
        setIcon(copyBtn, 'check');
        setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
      });
    } else {
      content.createEl('p', { text: msg.content });
    }

    // Show the footer row only for:
    //  - user messages (always — marks when the user sent)
    //  - assistant messages that carry a cost (the terminal message of a turn)
    // Intermediate assistant messages in a multi-step response have no cost
    // and get no footer, keeping the view clean.
    const hasCost = !!msg.cost && msg.cost > 0;
    if (msg.role === 'user' || hasCost) {
      const footer = el.createDiv('ct-message-footer');
      footer.createSpan({ cls: 'ct-message-ts', text: this.formatShortTime(msg.timestamp) });
      if (hasCost) {
        footer.createSpan({ cls: 'ct-cost', text: `$${msg.cost!.toFixed(4)}` });
      }
    }
  }

  private renderToolCalls(parent: HTMLElement, tools: ToolCallRecord[]): void {
    const wrapper = parent.createDiv('ct-tools');
    for (const tool of tools) {
      const pill = wrapper.createDiv('ct-tool-pill');
      const iconEl = pill.createSpan({ cls: 'ct-tool-pill-icon' });
      setIcon(iconEl, getToolIcon(tool.name));
      pill.createSpan({ cls: 'ct-tool-pill-name', text: formatToolName(tool.name) });
      if (tool.summary) pill.createSpan({ cls: 'ct-tool-pill-text', text: tool.summary });
      if (tool.timestamp) {
        pill.createSpan({ cls: 'ct-tool-pill-ts', text: this.formatShortTime(tool.timestamp) });
      }
    }
  }

  private renderPermissionCard(toolName: string, detail: string, done: (allow: boolean) => void): HTMLElement {
    // Anchor inside the active streaming element so the card sits visually
    // inside the current response turn rather than floating as a sibling that
    // can overlap the tool-pill list above it.
    const container = this.streamingEl ?? this.messagesEl;
    const card = container.createDiv('ct-permission-card');

    const header = card.createDiv('ct-permission-header');
    const iconEl = header.createSpan('ct-permission-icon');
    setIcon(iconEl, 'shield-alert');
    header.createSpan({ cls: 'ct-permission-label', text: 'Permission request' });

    const body = card.createDiv('ct-permission-body');
    body.createEl('code', { cls: 'ct-permission-tool', text: formatToolName(toolName) });
    if (detail) {
      body.createEl('p', { cls: 'ct-permission-detail', text: detail });
    }

    const actions = card.createDiv('ct-permission-actions');
    actions.createEl('button', { text: 'Deny', cls: 'ct-permission-btn ct-permission-deny' })
      .addEventListener('click', () => done(false));
    actions.createEl('button', { text: 'Allow', cls: 'ct-permission-btn ct-permission-allow' })
      .addEventListener('click', () => done(true));
    actions.createEl('button', { text: 'Always Allow', cls: 'ct-permission-btn ct-permission-always' })
      .addEventListener('click', async () => {
        this.plugin.settings.alwaysAllowedTools.push(toolName);
        await this.plugin.saveSettings();
        done(true);
      });

    return card;
  }

  private clearStreamingState(): void {
    if (this.streamingRenderTimer !== null) {
      clearTimeout(this.streamingRenderTimer);
      this.streamingRenderTimer = null;
    }
    this.streamingContent = '';
    this.streamingContentEl = null;
  }

  private scheduleStreamingRender(): void {
    if (this.streamingRenderTimer !== null) clearTimeout(this.streamingRenderTimer);
    this.streamingRenderTimer = setTimeout(() => {
      this.streamingRenderTimer = null;
      this.renderStreamingContent();
    }, 80);
  }

  private async renderStreamingContent(): Promise<void> {
    if (!this.streamingEl || !this.streamingContentEl) return;
    const content = this.streamingContent;
    this.streamingContentEl.empty();
    this.streamingContentEl.appendChild(sanitizeHTMLToDom(await marked.parse(content)));
    // Keep cursor inside the bubble after each re-render
    this.streamingContentEl.createSpan({ cls: 'ct-cursor' });
    this.scrollToBottom();
  }

  private handleEvent(event: ThreadEvent): void {
    switch (event.type) {
      case 'user_message_added': {
        // Only create the bubble when the message came from an external caller
        // (e.g. the voice plugin). When the message originates from the input box,
        // handleSendMessage() already inserted the bubble synchronously before
        // calling sendMessage(), so pendingUserEl is already set — skip it here
        // to avoid a duplicate.
        if (!this.pendingUserEl) {
          const userEl = this.messagesEl.createDiv('ct-message ct-message-user');
          this.pendingUserEl = userEl;
          const content = userEl.createDiv('ct-message-content');
          content.createEl('p', { text: event.message.content });
          if (event.message.images && event.message.images.length > 0) {
            const imgRow = content.createDiv('ct-message-images');
            for (const img of event.message.images) {
              const thumb = imgRow.createEl('img', { cls: 'ct-message-img-thumb' });
              thumb.src = `data:${img.mediaType};base64,${img.base64}`;
              thumb.title = img.name;
            }
          }
          this.scrollToBottom();
        }
        break;
      }

      case 'streaming_start': {
        this.streamingContent = '';
        if (!this.streamingEl) {
          this.createStreamingEl();
        }
        this.setRunningState(true);
        this.scrollToBottom();
        break;
      }

      case 'escalated': {
        this.statusBar.setText(`⚡ Using ${event.model} for this turn`);
        break;
      }

      case 'token': {
        if (!this.streamingEl) {
          this.createStreamingEl();
        }
        this.streamingContent += event.text;
        this.scheduleStreamingRender();
        break;
      }

      case 'tool_use': {
        if (this.streamingEl) {
          const pill = document.createElement('div');
          pill.className = 'ct-tool-pill ct-tool-active';
          const iconEl = document.createElement('span');
          iconEl.className = 'ct-tool-pill-icon';
          setIcon(iconEl, getToolIcon(event.record.name));
          const badge = document.createElement('span');
          badge.className = 'ct-tool-pill-name';
          badge.textContent = formatToolName(event.record.name);
          pill.append(iconEl, badge);
          if (event.record.summary) {
            const label = document.createElement('span');
            label.className = 'ct-tool-pill-text';
            label.textContent = event.record.summary;
            pill.append(label);
          }
          this.streamingEl.prepend(pill);
        }
        if (event.record.name === 'Write' || event.record.name === 'Edit') {
          const filePath = event.record.summary.replace(/^[^:]+: /, '');
          if (filePath) {
            // Delete before re-adding so the file moves to the end (most recent)
            this.editedFilesSet.delete(filePath);
            this.editedFilesSet.add(filePath);
            this.renderEditedFilesCard();
          }
        }
        break;
      }

      case 'message': {
        this.pendingUserEl = null; // assistant responded — user message is committed
        this.clearStreamingState();
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
        }
        this.appendMessage(event.message).then(() => this.scrollToBottom());
        this.scrollToBottom();
        this.plugin.saveSettings();
        if (this.plugin.settings.summarizationEnabled && this.activeThreadId) {
          const thread = this.manager.getThread(this.activeThreadId);
          if (thread) {
            const shouldAutoTitle = isDefaultThreadTitle(thread.title);
            const shouldFullSummarize = this.plugin.settings.autoSummarize;
            if (shouldAutoTitle || shouldFullSummarize) {
              this.runSummarize(thread.messages).then((result) => {
                if (result.summary && shouldFullSummarize) thread.summary = result.summary;
                if (result.title) this.applyAutoTitle(thread.id, result.title);
                this.plugin.saveSettings();
                if (this.activeThreadId === thread.id) {
                  this.renderTitleBar();
                  this.renderThreadInfo();
                  this.refreshLeafHeader();
                }
              }).catch(() => { /* silent fail for auto */ });
            }
          }
        }
        if (this.plugin.settings.saveThreadsToVault && this.activeThreadId) {
          const thread = this.manager.getThread(this.activeThreadId);
          if (thread) {
            this.plugin.persistence?.saveThread(thread).catch(console.error);
          }
        }
        break;
      }

      case 'recap': {
        this.renderThreadInfo();
        break;
      }

      case 'queued': {
        this.updateStatusBar();
        break;
      }

      case 'dequeued': {
        const userEl = this.messagesEl.createDiv('ct-message ct-message-user');
        this.pendingUserEl = userEl; // prevent the subsequent 'send' event from creating a duplicate bubble
        userEl.createDiv('ct-message-content').createEl('p', { text: event.text });
        this.scrollToBottom();
        break;
      }

      case 'done': {
        this.pendingUserEl = null;
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
          this.clearStreamingState();
        }
        this.taskPills.clear();
        // Message completed normally — discard the saved sent text so it can't
        // bleed into another thread if the user later stops a different thread.
        if (this.activeThreadId) this.lastSentTexts.delete(this.activeThreadId);
        this.setRunningState(false);
        break;
      }

      case 'interrupted': {
        // Roll back the user message bubble that was never processed
        if (this.pendingUserEl) {
          this.pendingUserEl.remove();
          this.pendingUserEl = null;
        }
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
          this.streamingContentEl = null;
          this.clearStreamingState();
        }
        this.taskPills.clear();
        // Restore the sent message so the user can edit and re-send
        const lastSent = this.activeThreadId ? this.lastSentTexts.get(this.activeThreadId) : undefined;
        if (lastSent) {
          this.inputEl.value = lastSent;
          this.lastSentTexts.delete(this.activeThreadId!);
        }
        this.setRunningState(false);
        break;
      }

      case 'cwd_changed': {
        this.renderThreadInfo();
        break;
      }

      case 'status': {
        if (event.status === 'compacting') {
          this.statusBar.setText('Compacting context...');
        } else if (event.status === null) {
          this.updateStatusBar();
        }
        break;
      }

      case 'compact': {
        this.appendMessage(event.message).then(() => this.scrollToBottom());
        this.plugin.saveSettings();
        break;
      }

      case 'task_started': {
        if (!this.streamingEl) this.createStreamingEl();
        const taskPill = document.createElement('div');
        taskPill.className = 'ct-tool-pill ct-tool-active ct-task-pill';
        const taskBadge = document.createElement('span');
        taskBadge.className = 'ct-tool-pill-name';
        taskBadge.textContent = 'task';
        const taskLabel = document.createElement('span');
        taskLabel.className = 'ct-tool-pill-text';
        taskLabel.textContent = event.description;
        taskPill.append(taskBadge, taskLabel);
        this.streamingEl!.prepend(taskPill);
        this.taskPills.set(event.taskId, taskPill);
        break;
      }

      case 'task_progress': {
        const progressPill = this.taskPills.get(event.taskId);
        if (progressPill) {
          const label = progressPill.querySelector('.ct-tool-pill-text');
          if (label) {
            const toolSuffix = event.lastToolName ? ` · ${event.lastToolName}` : '';
            label.textContent = event.description + toolSuffix;
          }
        }
        break;
      }

      case 'task_notification': {
        const notifPill = this.taskPills.get(event.taskId);
        if (notifPill) {
          notifPill.classList.remove('ct-tool-active');
          const icon = notifPill.querySelector('span:first-child');
          const label = notifPill.querySelector('.ct-tool-pill-text');
          if (event.status === 'completed') {
            notifPill.classList.add('ct-task-done');
            if (icon) (icon as HTMLElement).textContent = '✓ ';
          } else {
            notifPill.classList.add('ct-task-failed');
            if (icon) (icon as HTMLElement).textContent = '✗ ';
          }
          if (label) label.textContent = event.summary;
          this.taskPills.delete(event.taskId);
        }
        break;
      }

      case 'notification': {
        if (event.priority === 'low') break;
        new Notice(event.text, event.priority === 'immediate' ? 0 : 5000);
        break;
      }

      case 'api_retry': {
        this.statusBar.setText(`Retrying (${event.attempt}/${event.maxRetries})...`);
        break;
      }

      case 'rate_limit': {
        if (event.limitStatus === 'rejected') {
          const resetMsg = event.resetsAt
            ? ` Resets ${new Date(event.resetsAt).toLocaleTimeString()}.`
            : '';
          new Notice(`Rate limit reached.${resetMsg}`, 0);
          this.statusBar.setText('Rate limited');
        } else if (event.limitStatus === 'allowed_warning') {
          this.statusBar.setText('Approaching rate limit');
        }
        break;
      }

      case 'error': {
        this.clearStreamingState();
        this.taskPills.clear();
        if (this.streamingEl) {
          this.streamingEl.remove();
          this.streamingEl = null;
        }
        const errEl = this.messagesEl.createDiv('ct-message ct-error');
        errEl.createEl('pre', {
          text: event.error.message,
          cls: 'ct-error-text',
        });
        this.setRunningState(false);
        this.scrollToBottom();
        break;
      }
    }
  }

  private setRunningState(running: boolean): void {
    if (running) {
      this.sendBtn.addClass('ct-hidden');
      this.stopBtn.removeClass('ct-hidden');
      this.updateStatusBar();
    } else {
      this.sendBtn.removeClass('ct-hidden');
      this.stopBtn.addClass('ct-hidden');
      this.statusBar.setText('');
      this.inputEl.focus();
    }
  }

  private updateStatusBar(): void {
    if (!this.activeThreadId) return;
    const queued = this.manager.getQueuedMessage(this.activeThreadId);
    const count = this.manager.getQueuedCount(this.activeThreadId);
    if (queued) {
      const preview = queued.length > 40 ? queued.slice(0, 40) + '…' : queued;
      const countSuffix = count > 1 ? ` (+${count - 1} more)` : '';
      this.statusBar.setText(`Queued: "${preview}"${countSuffix}`);
    } else {
      this.statusBar.setText('');
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private addPasteAttachment(content: string): void {
    this.pendingAttachment = content;
    this.renderPasteChips();
    this.scheduleDraftSave();
  }

  private addFileAsTextAttachment(file: File): void {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      new Notice(`"${file.name}" is too large to attach (max 500 KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // Filename on the first line so the chip label and Claude's context both show it
      this.addPasteAttachment(`${file.name}\n${reader.result as string}`);
    };
    reader.onerror = () => new Notice(`Could not read "${file.name}".`);
    reader.readAsText(file);
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
      this.renderPasteChips();
      this.scheduleDraftSave();
    };
    reader.readAsDataURL(file);
  }

  private renderPasteChips(): void {
    this.pasteChipsEl.empty();
    if (!this.pendingAttachment && this.pendingImages.length === 0) {
      this.pasteChipsEl.addClass('ct-hidden');
      return;
    }
    this.pasteChipsEl.removeClass('ct-hidden');

    if (this.pendingAttachment) {
      const chip = this.pasteChipsEl.createDiv('ct-paste-chip');
      const firstLine = this.pendingAttachment.split('\n')[0].trim().slice(0, 40);
      chip.createSpan({ cls: 'ct-paste-chip-icon', text: '📄' });
      chip.createSpan({ cls: 'ct-paste-chip-label', text: firstLine || 'pasted text' });
      chip.createSpan({ cls: 'ct-paste-chip-meta', text: `${this.pendingAttachment.length.toLocaleString()} chars` });
      const removeBtn = chip.createEl('button', { cls: 'ct-paste-chip-remove', text: '×', attr: { title: 'Remove' } });
      removeBtn.addEventListener('click', () => {
        this.pendingAttachment = null;
        this.renderPasteChips();
        this.scheduleDraftSave();
      });
    }

    this.pendingImages.forEach((img, idx) => {
      const chip = this.pasteChipsEl.createDiv('ct-paste-chip ct-paste-chip-image');
      const thumb = chip.createEl('img', { cls: 'ct-paste-chip-thumb' });
      thumb.src = `data:${img.mediaType};base64,${img.base64}`;
      chip.createSpan({ cls: 'ct-paste-chip-label', text: img.name });
      const removeBtn = chip.createEl('button', { cls: 'ct-paste-chip-remove', text: '×', attr: { title: 'Remove' } });
      removeBtn.addEventListener('click', () => {
        this.pendingImages.splice(idx, 1);
        this.renderPasteChips();
        this.scheduleDraftSave();
      });
    });
  }

  private async sendMessage(): Promise<void> {
    const typed = this.inputEl.value.trim();
    const attachment = this.pendingAttachment;
    const images = this.pendingImages.slice();
    if (!typed && !attachment && images.length === 0) return;
    if (!this.activeThreadId) return;

    this.lastSentTexts.set(this.activeThreadId, typed);
    this.inputEl.value = '';
    this.pendingAttachment = null;
    this.pendingImages = [];
    this.renderPasteChips();
    // Clear any saved draft for this thread so it doesn't reappear
    if (this.activeThreadId) {
      const thread = this.manager.getThread(this.activeThreadId);
      if (thread) delete thread.draft;
    }

    // Dismiss the context banner as soon as the user sends — they're back in the thread
    this.hideSummaryBanner(false);

    // Dismiss the context banner as soon as the user sends — they're back in the thread
    this.hideSummaryBanner(false);

    // /fork [optional focus] — open ForkModal without sending a message to Claude.
    // Detected before the user bubble renders so no stray bubble is left behind.
    const forkMatch = typed.match(/^\/fork(?:\s+([\s\S]+))?$/i);
    if (forkMatch) {
      const focusArea = (forkMatch[1] ?? '').trim();
      await this.forkThread(this.activeThreadId!, focusArea || undefined);
      return;
    }

    let text = typed;
    if (attachment) {
      text = typed
        ? `${typed}\n\n\`\`\`\n${attachment}\n\`\`\``
        : `\`\`\`\n${attachment}\n\`\`\``;
    }

    // Resolve @this — substitute the currently open file before the mention resolver runs
    if (/@this\b/.test(text)) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        text = text.replace(/@this\b/g, `@[[${activeFile.basename}]]`);
      } else {
        new Notice('@this: no file is currently open in the editor');
      }
    }

    // Resolve @[[basename]] file mentions — append each file's content as context
    const mentionRegex = /@\[\[([^\]]+)\]\]/g;
    const mentions = [...text.matchAll(mentionRegex)].map(m => m[1]);
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
        text = text + '\n\n---\nReferenced files:\n\n' + fileContextParts.join('\n\n');
      }
    }

    if (!this.manager.isRunning(this.activeThreadId)) {
      const userEl = this.messagesEl.createDiv('ct-message ct-message-user');
      this.pendingUserEl = userEl;
      const content = userEl.createDiv('ct-message-content');
      if (typed) content.createEl('p', { text: typed });
      if (attachment) {
        const attachRow = content.createDiv('ct-message-attachment');
        attachRow.createSpan({ text: '📄 ' });
        attachRow.createSpan({ cls: 'ct-message-attachment-label', text: `${attachment.length.toLocaleString()} chars pasted` });
      }
      if (images.length > 0) {
        const imgRow = content.createDiv('ct-message-images');
        for (const img of images) {
          const thumb = imgRow.createEl('img', { cls: 'ct-message-img-thumb' });
          thumb.src = `data:${img.mediaType};base64,${img.base64}`;
          thumb.title = img.name;
        }
      }
      this.scrollToBottom();
    }

    const modelMatch = typed.match(/^\/model(?:\s+(\S+))?$/i);
    if (modelMatch) {
      const arg = (modelMatch[1] ?? '').toLowerCase();
      if (!arg) {
        const thread = this.manager.getThread(this.activeThreadId);
        const current = thread?.model ?? 'default';
        const infoEl = this.messagesEl.createDiv('ct-compact-divider');
        infoEl.createSpan({ cls: 'ct-compact-label', text: `Model: ${current}` });
        this.scrollToBottom();
        return;
      }
      if (!(arg in ThreadsView.MODEL_ALIASES)) {
        const errEl = this.messagesEl.createDiv('ct-message ct-error');
        errEl.createEl('p', { text: `Unknown model "${arg}". Use: opus, sonnet, haiku, default` });
        this.scrollToBottom();
        return;
      }
      const resolved = ThreadsView.MODEL_ALIASES[arg];
      this.manager.setThreadModel(this.activeThreadId, resolved);
      await this.plugin.saveSettings();
      const label = resolved ? `Model set to ${resolved}` : 'Model reset to default';
      const divider = this.messagesEl.createDiv('ct-compact-divider');
      divider.createSpan({ cls: 'ct-compact-label', text: label });
      this.renderThreadInfo();
      this.scrollToBottom();
      return;
    }

    try {
      await this.manager.sendMessage(this.activeThreadId, text || ' ', images.length > 0 ? images : undefined);
    } catch (err) {
      const errEl = this.messagesEl.createDiv('ct-message ct-error');
      errEl.createEl('p', { text: `Failed to send: ${(err as Error).message}` });
      this.setRunningState(false);
    }
  }

  private async stopMessage(): Promise<void> {
    if (this.activeThreadId) {
      await this.manager.interrupt(this.activeThreadId);
    }
  }

  private openThreadSwitcher(_event: MouseEvent): void {
    // Toggle: close if already open
    if (this.switcherPanelEl) {
      this.closeSwitcherPanel();
      return;
    }

    const titleRow = this.titleEl.closest('.ct-title-row') as HTMLElement ?? this.rootEl;
    const panel = titleRow.createDiv('ct-switcher-panel');
    this.switcherPanelEl = panel;

    const allThreads = this.manager.getThreads();
    const running: Thread[] = [];
    const unreviewed: Thread[] = [];
    const reviewed: Thread[] = [];
    const errors: Thread[] = [];
    const empty: Thread[] = [];

    for (const t of allThreads) {
      if (this.manager.isRunning(t.id)) running.push(t);
      else if (t.lastError) errors.push(t);
      else if (t.messages.length > 0) {
        if (t.reviewed) reviewed.push(t);
        else unreviewed.push(t);
      } else empty.push(t);
    }

    const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
    running.sort(byRecency);
    unreviewed.sort(byRecency);
    reviewed.sort(byRecency);
    errors.sort(byRecency);
    empty.sort(byRecency);

    const listEl = panel.createDiv('ct-agents-list');

    if (allThreads.length === 0) {
      listEl.createDiv({ cls: 'ct-agents-empty', text: 'No threads yet.' });
    }

    const renderSwitcherGroup = (label: string, threads: Thread[], state: string): void => {
      const group = listEl.createDiv('ct-agents-group');
      const labelEl = group.createDiv('ct-agents-group-label');
      labelEl.createSpan({ text: label });

      for (const thread of threads) {
        const isActive = thread.id === this.activeThreadId;
        const row = group.createDiv({
          cls: `ct-agents-row ct-agents-row-${state}${isActive ? ' ct-agents-row-active' : ''}`,
        });

        // Icon
        const iconEl = row.createDiv('ct-agents-icon');
        switch (state) {
          case 'running': iconEl.addClass('ct-agents-icon-running'); iconEl.setText('✽'); break;
          case 'error':   iconEl.addClass('ct-agents-icon-error');   iconEl.setText('✗'); break;
          case 'empty':   iconEl.addClass('ct-agents-icon-empty');   iconEl.setText('○'); break;
          default:        iconEl.addClass('ct-agents-icon-idle');    iconEl.setText('✓'); break;
        }

        const body = row.createDiv('ct-agents-row-body');
        body.createDiv({ cls: 'ct-agents-row-title', text: thread.title });

        // Summary for idle threads (same as AgentDashboard)
        const summary = thread.summary || thread.recap;
        if (summary && state === 'idle') {
          body.createDiv({ cls: 'ct-agents-row-summary', text: summary });
        }

        // Activity line
        let activityText = '';
        if (state === 'running') {
          activityText = this.manager.getThreadActivity(thread.id) || 'Working...';
        } else if (state === 'error') {
          activityText = thread.lastError ?? 'Error occurred';
        } else if (state === 'empty') {
          activityText = 'Ready to start';
        } else {
          const lastAssistant = [...thread.messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            const t = lastAssistant.content.replace(/```[\s\S]*?```/g, '[code]').replace(/\n/g, ' ').trim();
            activityText = t.length > 90 ? t.slice(0, 90) + '…' : t;
          } else {
            activityText = 'Completed';
          }
        }
        body.createDiv({ cls: 'ct-agents-row-activity', text: activityText });

        const meta = row.createDiv('ct-agents-row-meta');
        meta.createDiv({ cls: 'ct-agents-row-time', text: this.relativeTime(thread.updatedAt) });

        row.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          this.closeSwitcherPanel();
          this.setActiveThread(thread.id);
        });
      }
    };

    if (running.length > 0)   renderSwitcherGroup('Working',  running,    'running');
    if (unreviewed.length > 0) renderSwitcherGroup('New',      unreviewed, 'idle');
    if (reviewed.length > 0)  renderSwitcherGroup('Reviewed', reviewed,   'idle');
    if (errors.length > 0)    renderSwitcherGroup('Failed',   errors,     'error');
    if (empty.length > 0)     renderSwitcherGroup('Ready',    empty,      'empty');

    // Footer: new chat
    const footer = panel.createDiv('ct-switcher-footer');
    const newBtn = footer.createEl('button', { cls: 'ct-switcher-new-btn', text: '+ New chat' });
    newBtn.addEventListener('click', () => {
      this.closeSwitcherPanel();
      void this.openNewThread();
    });

    // Close on outside click (next tick so this click doesn't immediately re-close)
    setTimeout(() => {
      const outsideHandler = (e: MouseEvent) => {
        if (!panel.contains(e.target as Node) && !this.titleEl.contains(e.target as Node)) {
          this.closeSwitcherPanel();
        }
      };
      this.switcherOutsideHandler = outsideHandler;
      document.addEventListener('mousedown', outsideHandler, true);
    }, 0);
  }

  private closeSwitcherPanel(): void {
    this.switcherPanelEl?.remove();
    this.switcherPanelEl = null;
    if (this.switcherOutsideHandler) {
      document.removeEventListener('mousedown', this.switcherOutsideHandler, true);
      this.switcherOutsideHandler = null;
    }
  }

  private relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  async openNewThread(event?: MouseEvent): Promise<void> {
    const projects = this.manager.getProjects();

    if (projects.length === 0) {
      await this.createThreadWithProject(null);
      return;
    }

    const menu = new Menu();
    menu.addItem(item =>
      item.setTitle('New chat')
        .setIcon('square-pen')
        .onClick(() => this.createThreadWithProject(null)),
    );
    menu.addSeparator();
    for (const project of projects) {
      menu.addItem(item =>
        item.setTitle(project.name)
          .setIcon('folder')
          .onClick(() => this.createThreadWithProject(project.id)),
      );
    }

    if (event) menu.showAtMouseEvent(event);
    else menu.showAtPosition({ x: 0, y: 0 });
  }

  private async createThreadWithProject(projectId: string | null): Promise<void> {
    let cwd = this.plugin.getEffectiveCwd();
    if (projectId) {
      const project = this.manager.getProject(projectId);
      if (project) cwd = this.manager.getProjectCwd(project);
    }
    const thread = this.manager.createThread(
      `Thread ${this.manager.getThreads().length + 1}`,
      cwd,
      projectId ?? undefined,
    );
    await this.plugin.saveSettings();
    this.renderProjectBar(); // update thread count badges
    this.setActiveThread(thread.id);
  }

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

  private showSkillDropdown(query: string): void {
    const q = query.toLowerCase();
    const builtins = ThreadsView.BUILTIN_COMMANDS.filter(c => c.name.startsWith(q));
    const skills = this.skills.filter(s => s.name.toLowerCase().startsWith(q));
    const matches = [...builtins, ...skills];
    if (matches.length === 0) { this.hideSkillDropdown(); return; }
    this.skillDropdownItems = matches;
    if (this.skillDropdownIndex >= matches.length) this.skillDropdownIndex = 0;
    if (!this.skillDropdown) {
      this.skillDropdown = this.inputRowEl.createDiv('ct-skill-dropdown');
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
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    const inserted = '/' + skillName + ' ';
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
  }

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
    // Show @this at the top whenever the query is a prefix of "this" (includes empty query)
    const showThis = 'this'.startsWith(q);
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
      this.fileDropdown = this.inputRowEl.createDiv('ct-file-dropdown');
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

  navigateTab(direction: 1 | -1): void {
    const threads = this.manager.getThreads();
    if (threads.length <= 1) return;
    const idx = threads.findIndex(t => t.id === this.activeThreadId);
    const next = (idx + direction + threads.length) % threads.length;
    this.setActiveThread(threads[next].id);
  }

  switchToTabIndex(index: number): void {
    const threads = this.manager.getThreads();
    if (threads[index]) this.setActiveThread(threads[index].id);
  }

  private applyAutoTitle(threadId: string, title: string): void {
    const thread = this.manager.getThread(threadId);
    if (!thread || !title) return;
    if (isDefaultThreadTitle(thread.title)) {
      this.manager.renameThread(threadId, title);
    }
  }

  private closeThread(id: string): void {
    const threads = this.manager.getThreads();
    if (threads.length <= 1) return;

    const thread = this.manager.getThread(id);
    const hasMessages = thread && thread.messages.some((m) => m.role !== 'compact');

    if (hasMessages && this.plugin.settings.saveThreadsToVault && this.plugin.persistence) {
      // Archive to vault before removing from memory so the Bases Kanban retains it.
      thread.status = 'archived';
      this.plugin.persistence.saveThread(thread).catch(console.error);
    }

    this.manager.deleteThread(id);
    this.plugin.saveSettings();

    if (this.activeThreadId === id) {
      const remaining = this.manager.getThreads();
      if (remaining.length > 0) {
        this.setActiveThread(remaining[0].id);
      } else {
        this.activeThreadId = null;
        this.renderTitleBar();
        this.renderMessages();
      }
    } else {
      this.renderTitleBar();
    }
  }

  private renameThread(id: string, labelEl: HTMLElement): void {
    const current = labelEl.textContent ?? '';
    const input = document.createElement('input');
    input.className = 'ct-title-rename-input';
    input.value = current;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim() || current;
      this.manager.renameThread(id, val);
      this.plugin.saveSettings();
      if (id === this.activeThreadId) this.refreshLeafHeader();
      const newLabel = document.createElement('span');
      newLabel.className = 'ct-title-text';
      newLabel.textContent = val;
      newLabel.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.renameThread(id, newLabel);
      });
      input.replaceWith(newLabel);
      this.renderTitleBar();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        input.value = current;
        commit();
      }
    });
  }
}

class ForkModal extends Modal {
  private plugin: ClaudeThreadsPlugin;
  private sourceThread: Thread;
  private onFork: (prompt: string) => Promise<void>;
  private initialFocus: string;

  private focusInput!: HTMLInputElement;
  private promptTextarea!: HTMLTextAreaElement;
  private generateBtn!: HTMLButtonElement;
  private openForkBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private promptSection!: HTMLElement;
  private phase: 'input' | 'generating' | 'review' = 'input';

  constructor(
    app: App,
    plugin: ClaudeThreadsPlugin,
    sourceThread: Thread,
    onFork: (prompt: string) => Promise<void>,
    initialFocus?: string,
  ) {
    super(app);
    this.plugin = plugin;
    this.sourceThread = sourceThread;
    this.onFork = onFork;
    this.initialFocus = initialFocus ?? '';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ct-fork-modal');

    contentEl.createEl('h2', { text: 'Fork conversation' });
    contentEl.createEl('p', {
      text: 'Claude will distill the relevant context from this conversation and generate a focused starting prompt for a new thread.',
      cls: 'ct-fork-desc',
    });

    const focusSection = contentEl.createDiv({ cls: 'ct-fork-focus-section' });
    focusSection.createEl('label', {
      text: 'What should the new thread focus on? (optional)',
      cls: 'ct-fork-label',
    });
    this.focusInput = focusSection.createEl('input', {
      type: 'text',
      placeholder: 'e.g. "the auth bug", "refactoring the API layer", "next deployment steps"',
    });
    this.focusInput.addClass('ct-fork-input');
    this.focusInput.style.cssText = 'width:100%;margin-top:4px;';
    if (this.initialFocus) {
      this.focusInput.value = this.initialFocus;
    }

    this.statusEl = contentEl.createDiv({ cls: 'ct-fork-status' });
    this.statusEl.style.display = 'none';

    this.promptSection = contentEl.createDiv({ cls: 'ct-fork-prompt-section' });
    this.promptSection.style.display = 'none';
    this.promptSection.createEl('label', {
      text: 'Generated starting prompt — edit before opening:',
      cls: 'ct-fork-label',
    });
    this.promptTextarea = this.promptSection.createEl('textarea');
    this.promptTextarea.addClass('ct-fork-textarea');
    this.promptTextarea.rows = 8;
    this.promptTextarea.style.cssText = 'width:100%;resize:vertical;margin-top:4px;';

    const btnRow = contentEl.createDiv({ cls: 'ct-fork-btn-row' });
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';

    this.generateBtn = btnRow.createEl('button', { text: 'Generate fork prompt' });
    this.generateBtn.addClass('mod-cta');
    this.generateBtn.addEventListener('click', () => void this.handleGenerate());

    this.openForkBtn = btnRow.createEl('button', { text: 'Open fork' });
    this.openForkBtn.addClass('mod-cta');
    this.openForkBtn.style.display = 'none';
    this.openForkBtn.addEventListener('click', () => void this.handleOpenFork());

    this.focusInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.handleGenerate();
      }
    });

    this.focusInput.focus();
  }

  private async handleGenerate(): Promise<void> {
    if (this.phase === 'generating') return;
    this.phase = 'generating';

    this.generateBtn.disabled = true;
    this.generateBtn.textContent = 'Generating…';
    this.statusEl.style.display = 'block';
    this.statusEl.textContent = 'Generating fork prompt…';
    this.promptSection.style.display = 'none';
    this.openForkBtn.style.display = 'none';

    try {
      const focus = this.focusInput.value;
      const result = await this.plugin.inProcessSummarizer.generateForkPrompt(
        this.sourceThread.messages,
        focus,
        this.plugin.settings.claudeBinaryPath,
        this.plugin.settings.inprocessModel,
        this.plugin.settings.extraEnv,
        (status: string) => { this.statusEl.textContent = status; },
      );

      this.promptTextarea.value = result;
      this.promptSection.style.display = 'block';
      this.statusEl.style.display = 'none';
      this.generateBtn.textContent = 'Regenerate';
      this.generateBtn.disabled = false;
      this.openForkBtn.style.display = 'inline-block';
      this.phase = 'review';
    } catch (err) {
      this.statusEl.textContent = `Error: ${(err as Error).message}`;
      this.generateBtn.textContent = 'Try again';
      this.generateBtn.disabled = false;
      this.phase = 'input';
    }
  }

  private async handleOpenFork(): Promise<void> {
    const prompt = this.promptTextarea.value.trim();
    if (!prompt) return;
    this.openForkBtn.disabled = true;
    this.openForkBtn.textContent = 'Opening…';
    try {
      await this.onFork(prompt);
      this.close();
    } catch (err) {
      new Notice(`Fork failed: ${(err as Error).message}`, 8000);
      this.openForkBtn.disabled = false;
      this.openForkBtn.textContent = 'Open fork';
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Returns a display-friendly version of an absolute path.
 * Replaces the home directory with ~ and keeps only the last two path segments
 * so the cwd badge stays compact even for deeply-nested repos.
 */
function shortenPath(fullPath: string): string {
  const home = os.homedir();
  const withTilde = fullPath.startsWith(home)
    ? '~' + fullPath.slice(home.length)
    : fullPath;
  const parts = withTilde.split('/').filter(Boolean);
  if (parts.length <= 3) return withTilde;
  return '.../' + parts.slice(-2).join('/');
}


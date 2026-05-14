import { ItemView, WorkspaceLeaf, Modal, Menu, setIcon, Notice, sanitizeHTMLToDom } from 'obsidian';
import { marked } from 'marked';
import type { Thread, ChatMessage, ToolCallRecord, AskQuestion, ImageAttachment, ImageMediaType } from './types';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { SummarizeResult } from './InProcessSummarizer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type ClaudeThreadsPlugin from './main';

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

  // Pending paste attachments
  private pendingAttachment: string | null = null;
  private pendingImages: ImageAttachment[] = [];

  // Active subagent task pills: taskId → pill element
  private taskPills: Map<string, HTMLElement> = new Map();

  // The user-message bubble we just inserted, so we can remove it on interrupt
  private pendingUserEl: HTMLElement | null = null;

  // Project indicator pill (near input)
  private projectIndicatorEl!: HTMLElement;

  // Slash command autocomplete
  // Tab overflow / new-thread button (combined)
  private newThreadBtn!: HTMLButtonElement;
  private threadAccessTimes: Map<string, number> = new Map();
  private static readonly MAX_VISIBLE_TABS = 4;

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
    return 'Claude Threads';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    this.buildUI();

    this.manager.permissionHandler = (toolName, detail) => {
      // First-party Obsidian MCP tools are always trusted — no prompt needed.
      if (toolName.startsWith('obsidian_')) return Promise.resolve(true);
      if (this.plugin.settings.alwaysAllowedTools.includes(toolName)) return Promise.resolve(true);
      return new Promise((resolve) => {
        let resolved = false;
        const done = (allow: boolean) => { if (!resolved) { resolved = true; resolve(allow); } };
        const modal = new Modal(this.app);
        modal.titleEl.setText(toolName);
        if (detail) modal.contentEl.createEl('p', { text: detail });
        const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' });
        btnRow.createEl('button', { text: 'Deny', cls: 'mod-warning' }).onclick = () => { done(false); modal.close(); };
        btnRow.createEl('button', { text: 'Allow' }).onclick = () => { done(true); modal.close(); };
        btnRow.createEl('button', { text: 'Always Allow', cls: 'mod-cta' }).onclick = async () => {
          this.plugin.settings.alwaysAllowedTools.push(toolName);
          await this.plugin.saveSettings();
          done(true);
          modal.close();
        };
        modal.onClose = () => done(false);
        modal.open();
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
      const thread = this.manager.createThread(title ?? `Thread ${this.manager.getThreads().length + 1}`, this.plugin.getEffectiveCwd());
      await this.plugin.saveSettings();
      this.setActiveThread(thread.id);
      if (initialPrompt) {
        this.inputEl.value = initialPrompt;
      }
      return { threadId: thread.id, title: thread.title };
    };

    this.unsubscribe = this.manager.subscribe((threadId, event) => {
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

    this.renderTabs();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    this.rootEl = root;
    root.empty();
    root.addClass('ct-root');
    root.setAttribute('data-density', this.plugin.settings.layoutDensity ?? 'comfortable');

    const tabRow = root.createDiv('ct-tab-row');
    this.tabBar = tabRow.createDiv('ct-tab-bar');
    this.newThreadBtn = tabRow.createEl('button', { cls: 'ct-tab-new', text: '+', attr: { title: 'New thread' } });
    this.newThreadBtn.addEventListener('click', (e) => this.openNewThread(e));
    this.threadInfoBar = root.createDiv('ct-thread-info-bar');

    this.mainEl = root.createDiv('ct-main');
    this.messagesEl = this.mainEl.createDiv('ct-messages');
    this.statusBar = this.mainEl.createDiv('ct-status-bar');

    this.inputRowEl = this.mainEl.createDiv('ct-input-row');
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
    this.moreBtn = inputActions.createEl('button', {
      cls: 'ct-more-btn',
      attr: { title: 'More actions' },
    });
    setIcon(this.moreBtn, 'menu');
    this.moreBtn.addEventListener('click', (e) => this.toggleMoreMenu(e));

    this.inputEl.addEventListener('keydown', (e) => {
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
        this.sendMessage();
      }
    });
    this.inputEl.addEventListener('input', () => {
      const query = this.getSlashQuery();
      if (query !== null) this.showSkillDropdown(query);
      else this.hideSkillDropdown();
    });
    this.inputEl.addEventListener('blur', () => {
      setTimeout(() => this.hideSkillDropdown(), 150);
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
    this.inputRowEl.addEventListener('dragleave', () => {
      this.inputRowEl.removeClass('ct-drag-over');
    });
    this.inputRowEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.inputRowEl.removeClass('ct-drag-over');
      const files = Array.from(e.dataTransfer?.files ?? []);
      files.filter(f => f.type.startsWith('image/')).forEach(f => this.addImageAttachment(f));
    });
    this.sendBtn.addEventListener('click', () => this.sendMessage());
    this.stopBtn.addEventListener('click', () => this.stopMessage());

    this.projectIndicatorEl = this.inputRowEl.createDiv('ct-project-indicator ct-hidden');
  }

  private renderTabs(): void {
    this.tabBar.empty();
    const threads = this.manager.getThreads();

    const { visible, hidden } = this.computeTabOverflow(threads);

    for (const thread of visible) {
      this.renderSingleTab(thread);
    }

    // When threads overflow, show a count badge and accent colour on the button
    if (hidden.length > 0) {
      this.newThreadBtn.textContent = `+${hidden.length}`;
      this.newThreadBtn.setAttribute('title', `${hidden.length} hidden thread${hidden.length > 1 ? 's' : ''} · click for all options`);
      this.newThreadBtn.addClass('ct-has-overflow');
    } else {
      this.newThreadBtn.textContent = '+';
      this.newThreadBtn.setAttribute('title', 'New thread');
      this.newThreadBtn.removeClass('ct-has-overflow');
    }
  }

  /** Splits threads into visible (tab bar) and hidden (overflow menu), preserving creation
   *  order for visible tabs so positions stay stable as you switch between threads. */
  private computeTabOverflow(threads: Thread[]): { visible: Thread[]; hidden: Thread[] } {
    if (threads.length <= ThreadsView.MAX_VISIBLE_TABS) {
      return { visible: threads, hidden: [] };
    }

    // Rank by recency: max of last-message time and last-accessed time
    const byRecency = [...threads].sort(
      (a, b) => this.getThreadRecency(b) - this.getThreadRecency(a),
    );

    // Active thread always gets a slot; fill remaining slots with most-recent others
    const active = byRecency.find(t => t.id === this.activeThreadId);
    const others = byRecency.filter(t => t.id !== this.activeThreadId);
    const slotsForOthers = ThreadsView.MAX_VISIBLE_TABS - (active ? 1 : 0);

    const visibleIds = new Set([
      ...(active ? [active.id] : []),
      ...others.slice(0, slotsForOthers).map(t => t.id),
    ]);

    // Visible tabs stay in their original creation order (stable positions)
    const visible = threads.filter(t => visibleIds.has(t.id));
    // Overflow menu shows most-recently-active threads first
    const hidden = others.slice(slotsForOthers);

    return { visible, hidden };
  }

  private getThreadRecency(thread: Thread): number {
    return Math.max(thread.updatedAt, this.threadAccessTimes.get(thread.id) ?? 0);
  }

  private renderSingleTab(thread: Thread): void {
    const tab = this.tabBar.createEl('button', {
      cls: `ct-tab ${thread.id === this.activeThreadId ? 'ct-tab-active' : ''}`,
    });

    const label = tab.createSpan({ cls: 'ct-tab-label', text: thread.title });

    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.renameThread(thread.id, label);
    });

    tab.addEventListener('click', () => this.setActiveThread(thread.id));

    const closeBtn = tab.createEl('button', { cls: 'ct-tab-close', text: '×', attr: { title: 'Close thread' } });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeThread(thread.id);
    });
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

  private setActiveThread(id: string): void {
    this.activeThreadId = id;
    this.threadAccessTimes.set(id, Date.now());
    if (!this.tabBar) return; // buildUI hasn't run yet; onOpen will call us again with the right id
    this.manager.notifyActiveThreadChanged(id);
    this.renderTabs();
    this.renderThreadInfo();
    this.renderMessages();
    this.setRunningState(this.manager.isRunning(id));
    this.updateProjectIndicator();
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

  private renderThreadInfo(): void {
    this.threadInfoBar.empty();
    if (!this.activeThreadId) return;
    const thread = this.manager.getThread(this.activeThreadId);
    if (!thread) return;

    // Summary/recap lives in the Agent Dashboard — only show model badge here
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
    menu.showAtMouseEvent(event);
  }

  private async runSummarize(messages: ChatMessage[], onProgress?: (s: string) => void): Promise<SummarizeResult> {
    if (this.plugin.settings.summarizationMode === 'inprocess') {
      return this.plugin.inProcessSummarizer.summarize(
        messages,
        this.plugin.settings.claudeBinaryPath,
        this.plugin.settings.inprocessModel,
        this.plugin.settings.extraEnv,
        onProgress,
      );
    }
    return this.plugin.summarizer.summarize(
      messages,
      this.plugin.settings.summarizationEndpoint,
      this.plugin.settings.summarizationModel,
    );
  }

  private async summarizeThread(threadId: string): Promise<void> {
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
      if (result.title) this.applyAutoTitle(thread.id, result.title);
      await this.plugin.saveSettings();
      this.statusBar.setText('');
      this.moreBtn.removeClass('ct-summarize-spinning');
      setIcon(this.moreBtn, 'menu');
      this.moreBtn.disabled = false;
      this.renderTabs();
      this.renderThreadInfo();
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

  private createStreamingEl(): void {
    this.streamingEl = this.messagesEl.createDiv('ct-message ct-message-assistant ct-streaming');
    this.streamingContentEl = this.streamingEl.createDiv('ct-message-content');
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

    if (msg.cost && msg.cost > 0) {
      el.createEl('span', { cls: 'ct-cost', text: `$${msg.cost.toFixed(4)}` });
    }
  }

  private renderToolCalls(parent: HTMLElement, tools: ToolCallRecord[]): void {
    const wrapper = parent.createDiv('ct-tools');
    for (const tool of tools) {
      const pill = wrapper.createDiv('ct-tool-pill');
      pill.createSpan({ cls: 'ct-tool-pill-name', text: tool.name.toLowerCase() });
      pill.createSpan({ cls: 'ct-tool-pill-text', text: tool.summary });
    }
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
          const badge = document.createElement('span');
          badge.className = 'ct-tool-pill-name';
          badge.textContent = event.record.name.toLowerCase();
          const label = document.createElement('span');
          label.className = 'ct-tool-pill-text';
          label.textContent = event.record.summary;
          pill.append(badge, label);
          this.streamingEl.prepend(pill);
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
        if (this.plugin.settings.autoSummarize && this.plugin.settings.summarizationEnabled && this.activeThreadId) {
          const thread = this.manager.getThread(this.activeThreadId);
          if (thread) {
            this.runSummarize(thread.messages).then((result) => {
              thread.summary = result.summary;
              if (result.title) this.applyAutoTitle(thread.id, result.title);
              this.plugin.saveSettings();
              if (this.activeThreadId === thread.id) {
                this.renderTabs();
                this.renderThreadInfo();
              }
            }).catch(() => { /* silent fail for auto */ });
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
        this.setRunningState(false);
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
    if (queued) {
      const preview = queued.length > 40 ? queued.slice(0, 40) + '…' : queued;
      this.statusBar.setText(`Claude is thinking... · Queued: "${preview}"`);
    } else {
      this.statusBar.setText('Claude is thinking...');
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private addPasteAttachment(content: string): void {
    this.pendingAttachment = content;
    this.renderPasteChips();
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
      });
    });
  }

  private async sendMessage(): Promise<void> {
    const typed = this.inputEl.value.trim();
    const attachment = this.pendingAttachment;
    const images = this.pendingImages.slice();
    if (!typed && !attachment && images.length === 0) return;
    if (!this.activeThreadId) return;

    this.inputEl.value = '';
    this.pendingAttachment = null;
    this.pendingImages = [];
    this.renderPasteChips();

    let text = typed;
    if (attachment) {
      text = typed
        ? `${typed}\n\n\`\`\`\n${attachment}\n\`\`\``
        : `\`\`\`\n${attachment}\n\`\`\``;
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

  async openNewThread(event?: MouseEvent): Promise<void> {
    const threads = this.manager.getThreads();
    const { hidden } = this.computeTabOverflow(threads);
    const projects = this.manager.getProjects();

    // Nothing to put in a menu — create directly
    if (hidden.length === 0 && projects.length === 0) {
      await this.createThreadWithProject(null);
      return;
    }

    const menu = new Menu();

    // Overflow threads at the top, most-recently-active first
    if (hidden.length > 0) {
      for (const thread of hidden) {
        menu.addItem(item =>
          item
            .setTitle(thread.title)
            .setIcon(this.manager.isRunning(thread.id) ? 'loader' : 'message-square')
            .onClick(() => this.setActiveThread(thread.id)),
        );
      }
      menu.addSeparator();
    }

    // New chat — no project
    menu.addItem(item =>
      item.setTitle('New chat')
        .setIcon('square-pen')
        .onClick(() => this.createThreadWithProject(null)),
    );

    // New chat — per project
    if (projects.length > 0) {
      menu.addSeparator();
      for (const project of projects) {
        menu.addItem(item =>
          item.setTitle(project.name)
            .setIcon('folder')
            .onClick(() => this.createThreadWithProject(project.id)),
        );
      }
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
    if (/^Thread \d+$/.test(thread.title)) {
      this.manager.renameThread(threadId, title);
    }
  }

  private closeThread(id: string): void {
    const threads = this.manager.getThreads();
    if (threads.length <= 1) return;

    this.manager.deleteThread(id);
    this.plugin.saveSettings();

    if (this.activeThreadId === id) {
      const remaining = this.manager.getThreads();
      if (remaining.length > 0) {
        this.setActiveThread(remaining[0].id);
      } else {
        this.activeThreadId = null;
        this.renderTabs();
        this.renderMessages();
      }
    } else {
      this.renderTabs();
    }
  }

  private renameThread(id: string, labelEl: HTMLElement): void {
    const current = labelEl.textContent ?? '';
    const input = document.createElement('input');
    input.className = 'ct-tab-rename-input';
    input.value = current;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim() || current;
      this.manager.renameThread(id, val);
      this.plugin.saveSettings();
      const newLabel = document.createElement('span');
      newLabel.className = 'ct-tab-label';
      newLabel.textContent = val;
      newLabel.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.renameThread(id, newLabel);
      });
      input.replaceWith(newLabel);
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


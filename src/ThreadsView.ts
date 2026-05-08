import { ItemView, WorkspaceLeaf, Modal, setIcon, Notice, sanitizeHTMLToDom } from 'obsidian';
import { marked } from 'marked';
import type { Thread, ChatMessage, ToolCallRecord, AskQuestion } from './types';
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
  private streamingContent = '';
  private streamingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  // DOM refs
  private tabBar!: HTMLElement;
  private threadInfoBar!: HTMLElement;
  private mainEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusBar!: HTMLElement;

  // Slash command autocomplete
  private skills: { name: string; description: string }[] = [];
  private skillDropdown: HTMLElement | null = null;
  private skillDropdownItems: { name: string; description: string }[] = [];
  private skillDropdownIndex = 0;

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

    this.manager.permissionHandler = (toolName, detail) =>
      new Promise((resolve) => {
        let resolved = false;
        const done = (allow: boolean) => { if (!resolved) { resolved = true; resolve(allow); } };
        const modal = new Modal(this.app);
        modal.titleEl.setText(toolName);
        if (detail) modal.contentEl.createEl('p', { text: detail });
        const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' });
        btnRow.createEl('button', { text: 'Deny', cls: 'mod-warning' }).onclick = () => { done(false); modal.close(); };
        btnRow.createEl('button', { text: 'Allow', cls: 'mod-cta' }).onclick = () => { done(true); modal.close(); };
        modal.onClose = () => done(false);
        modal.open();
      });

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
          for (const [q, vals] of Object.entries(answers)) result[q] = vals.join(', ');
          resolve(result);
          modal.close();
        };

        modal.onClose = () => {
          const result: Record<string, string> = {};
          for (const [q, vals] of Object.entries(answers)) result[q] = vals.join(', ');
          resolve(result);
        };

        modal.open();
      });

    this.unsubscribe = this.manager.subscribe((threadId, event) => {
      if (threadId === this.activeThreadId) {
        this.handleEvent(event);
      }
    });

    const threads = this.manager.getThreads();
    if (threads.length > 0) {
      this.setActiveThread(threads[0].id);
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
    root.empty();
    root.addClass('ct-root');

    this.tabBar = root.createDiv('ct-tab-bar');
    this.threadInfoBar = root.createDiv('ct-thread-info-bar');

    this.mainEl = root.createDiv('ct-main');
    this.messagesEl = this.mainEl.createDiv('ct-messages');
    this.statusBar = this.mainEl.createDiv('ct-status-bar');

    const inputRow = this.mainEl.createDiv('ct-input-row');

    this.loadSkills();
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'ct-input',
      attr: { placeholder: 'Message Claude... (Enter to send, Shift+Enter for newline)' },
    });
    this.sendBtn = inputRow.createEl('button', { cls: 'ct-send-btn', text: '↵' });
    this.stopBtn = inputRow.createEl('button', {
      cls: 'ct-stop-btn ct-hidden',
      text: '■',
      attr: { title: 'Stop' },
    });

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
    this.sendBtn.addEventListener('click', () => this.sendMessage());
    this.stopBtn.addEventListener('click', () => this.stopMessage());
  }

  private renderTabs(): void {
    this.tabBar.empty();
    const threads = this.manager.getThreads();

    for (const thread of threads) {
      const tab = this.tabBar.createEl('button', {
        cls: `ct-tab ${thread.id === this.activeThreadId ? 'ct-tab-active' : ''}`,
      });

      const label = tab.createSpan({ cls: 'ct-tab-label', text: thread.title });

      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.renameThread(thread.id, label);
      });

      tab.addEventListener('click', () => this.setActiveThread(thread.id));

      const closeBtn = tab.createEl('button', { cls: 'ct-tab-close', text: '×' });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeThread(thread.id);
      });
    }

    const newBtn = this.tabBar.createEl('button', {
      cls: 'ct-tab-new',
      text: '+',
      attr: { title: 'New thread' },
    });
    newBtn.addEventListener('click', () => this.openNewThread());
  }

  private setActiveThread(id: string): void {
    this.activeThreadId = id;
    this.renderTabs();
    this.renderThreadInfo();
    this.renderMessages();
    this.setRunningState(this.manager.isRunning(id));
  }

  private renderThreadInfo(): void {
    this.threadInfoBar.empty();
    if (!this.activeThreadId) return;
    const thread = this.manager.getThread(this.activeThreadId);
    if (!thread) return;

    const summaryText = thread.summary || thread.recap;
    if (summaryText) {
      this.threadInfoBar.createSpan({
        cls: 'ct-thread-info-recap',
        text: summaryText,
      });
    }

    if (this.plugin.settings.summarizationEnabled && thread.messages.length > 0) {
      const btn = this.threadInfoBar.createEl('button', {
        cls: 'ct-summarize-btn',
        attr: { title: 'Summarize thread' },
      });
      setIcon(btn, 'brain-circuit');
      btn.addEventListener('click', () => this.summarizeThread(thread.id, btn));
    }
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

  private async summarizeThread(threadId: string, btn: HTMLButtonElement): Promise<void> {
    const thread = this.manager.getThread(threadId);
    if (!thread || thread.messages.length === 0) return;

    btn.disabled = true;
    setIcon(btn, 'loader');
    btn.addClass('ct-summarize-spinning');

    const onProgress = (status: string) => {
      this.statusBar.setText(status);
    };

    try {
      const result = await this.runSummarize(thread.messages, onProgress);
      thread.summary = result.summary;
      if (result.title) this.applyAutoTitle(thread.id, result.title);
      await this.plugin.saveSettings();
      this.statusBar.setText('');
      btn.removeClass('ct-summarize-spinning');
      setIcon(btn, 'brain-circuit');
      btn.disabled = false;
      this.renderTabs();
      this.renderThreadInfo();
    } catch (err) {
      console.error('[Claude Threads] summarize error:', err);
      this.statusBar.setText('');
      btn.removeClass('ct-summarize-spinning');
      setIcon(btn, 'brain-circuit');
      btn.disabled = false;
      new Notice(`Summarization failed: ${(err as Error).message}`, 8000);
    }
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
      empty.createEl('p', { text: '👋 Start a conversation' });
      empty.createEl('p', {
        cls: 'ct-empty-sub',
        text: `Working in: ${thread.cwd || 'home directory'}`,
      });
      return;
    }

    for (const msg of thread.messages) {
      await this.appendMessage(msg);
    }

    if (this.manager.isRunning(this.activeThreadId)) {
      this.streamingEl = this.messagesEl.createDiv('ct-message ct-message-assistant ct-streaming');
      const cursor = this.streamingEl.createSpan({ cls: 'ct-cursor' });
      this.streamingEl.append(cursor);
    }

    this.scrollToBottom();
    this.setRunningState(this.manager.isRunning(this.activeThreadId));
  }

  private async appendMessage(msg: ChatMessage): Promise<void> {
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
      pill.createSpan({ text: '⚙ ' });
      pill.createSpan({ cls: 'ct-tool-pill-text', text: tool.summary });
    }
  }

  private clearStreamingState(): void {
    if (this.streamingRenderTimer !== null) {
      clearTimeout(this.streamingRenderTimer);
      this.streamingRenderTimer = null;
    }
    this.streamingContent = '';
  }

  private scheduleStreamingRender(): void {
    if (this.streamingRenderTimer !== null) clearTimeout(this.streamingRenderTimer);
    this.streamingRenderTimer = setTimeout(() => {
      this.streamingRenderTimer = null;
      this.renderStreamingContent();
    }, 80);
  }

  private async renderStreamingContent(): Promise<void> {
    if (!this.streamingEl) return;
    const content = this.streamingContent;
    this.streamingEl.empty();
    this.streamingEl.appendChild(sanitizeHTMLToDom(await marked.parse(content)));
    this.streamingEl.createSpan({ cls: 'ct-cursor' });
    this.scrollToBottom();
  }

  private handleEvent(event: ThreadEvent): void {
    switch (event.type) {
      case 'streaming_start': {
        this.streamingContent = '';
        if (!this.streamingEl) {
          this.streamingEl = this.messagesEl.createDiv(
            'ct-message ct-message-assistant ct-streaming',
          );
          this.streamingEl.createSpan({ cls: 'ct-cursor' });
        }
        this.setRunningState(true);
        this.scrollToBottom();
        break;
      }

      case 'token': {
        if (!this.streamingEl) {
          this.streamingEl = this.messagesEl.createDiv(
            'ct-message ct-message-assistant ct-streaming',
          );
        }
        this.streamingContent += event.text;
        this.scheduleStreamingRender();
        break;
      }

      case 'tool_use': {
        if (this.streamingEl) {
          const pill = document.createElement('div');
          pill.className = 'ct-tool-pill ct-tool-active';
          const icon = document.createElement('span');
          icon.textContent = '⚙ ';
          const label = document.createElement('span');
          label.className = 'ct-tool-pill-text';
          label.textContent = event.record.summary;
          pill.append(icon, label);
          this.streamingEl.prepend(pill);
        }
        break;
      }

      case 'message': {
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

      case 'done': {
        this.setRunningState(false);
        break;
      }

      case 'error': {
        this.clearStreamingState();
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
      this.inputEl.disabled = true;
      this.statusBar.setText('Claude is thinking...');
    } else {
      this.sendBtn.removeClass('ct-hidden');
      this.stopBtn.addClass('ct-hidden');
      this.inputEl.disabled = false;
      this.statusBar.setText('');
      this.inputEl.focus();
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async sendMessage(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || !this.activeThreadId) return;
    if (this.manager.isRunning(this.activeThreadId)) return;

    this.inputEl.value = '';

    const userEl = this.messagesEl.createDiv('ct-message ct-message-user');
    userEl.createDiv('ct-message-content').createEl('p', { text });
    this.scrollToBottom();

    try {
      await this.manager.sendMessage(this.activeThreadId, text);
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

  async openNewThread(): Promise<void> {
    const thread = this.manager.createThread(
      `Thread ${this.manager.getThreads().length + 1}`,
      this.plugin.getEffectiveCwd(),
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
    const matches = this.skills.filter(s => s.name.toLowerCase().startsWith(query.toLowerCase()));
    if (matches.length === 0) { this.hideSkillDropdown(); return; }
    this.skillDropdownItems = matches;
    if (this.skillDropdownIndex >= matches.length) this.skillDropdownIndex = 0;
    if (!this.skillDropdown) {
      this.skillDropdown = this.mainEl.createDiv('ct-skill-dropdown');
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


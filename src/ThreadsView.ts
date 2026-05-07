import { ItemView, WorkspaceLeaf, MarkdownRenderer, Modal, App } from 'obsidian';
import type { Thread, ChatMessage, ToolCallRecord } from './types';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
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
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusBar!: HTMLElement;

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

    this.unsubscribe = this.manager.subscribe((threadId, event) => {
      if (threadId === this.activeThreadId) {
        this.handleEvent(event);
      }
    });

    const threads = this.manager.getThreads();
    if (threads.length > 0) {
      this.setActiveThread(threads[0].id);
    } else {
      const thread = this.manager.createThread('Thread 1', this.plugin.settings.defaultCwd);
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

    const main = root.createDiv('ct-main');
    this.messagesEl = main.createDiv('ct-messages');
    this.statusBar = main.createDiv('ct-status-bar');

    const inputRow = main.createDiv('ct-input-row');
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
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
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
    this.renderMessages();
  }

  private renderMessages(): void {
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
      this.appendMessage(msg);
    }

    if (this.manager.isRunning(this.activeThreadId)) {
      this.streamingEl = this.messagesEl.createDiv('ct-message ct-message-assistant ct-streaming');
      const cursor = this.streamingEl.createSpan({ cls: 'ct-cursor' });
      this.streamingEl.append(cursor);
    }

    this.scrollToBottom();
    this.setRunningState(this.manager.isRunning(this.activeThreadId));
  }

  private appendMessage(msg: ChatMessage): void {
    const el = this.messagesEl.createDiv(
      `ct-message ct-message-${msg.role}`,
    );

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      this.renderToolCalls(el, msg.toolCalls);
    }

    const content = el.createDiv('ct-message-content');
    if (msg.role === 'assistant') {
      MarkdownRenderer.render(this.app, msg.content, content, '', this);
    } else {
      content.createEl('p', { text: msg.content });
    }

    if (msg.cost && msg.cost > 0) {
      el.createEl('span', {
        cls: 'ct-cost',
        text: `$${msg.cost.toFixed(4)}`,
      });
    }
  }

  private renderToolCalls(parent: HTMLElement, tools: ToolCallRecord[]): void {
    const wrapper = parent.createDiv('ct-tools');
    for (const tool of tools) {
      wrapper.createEl('span', { cls: 'ct-tool-pill', text: `⚙ ${tool.summary}` });
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
    await MarkdownRenderer.render(this.app, content, this.streamingEl, '', this);
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
          const pill = document.createElement('span');
          pill.className = 'ct-tool-pill ct-tool-active';
          pill.textContent = `⚙ ${event.record.summary}`;
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
        this.appendMessage(event.message);
        this.scrollToBottom();
        this.plugin.saveSettings();
        if (this.plugin.settings.saveThreadsToVault && this.activeThreadId) {
          const thread = this.manager.getThread(this.activeThreadId);
          if (thread) {
            this.plugin.persistence?.saveThread(thread).catch(console.error);
          }
        }
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
    const title = await promptText(this.app, 'Thread name', `Thread ${this.manager.getThreads().length + 1}`);
    const thread = this.manager.createThread(
      title || `Thread ${this.manager.getThreads().length}`,
      this.plugin.settings.defaultCwd,
    );
    await this.plugin.saveSettings();
    this.setActiveThread(thread.id);
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

async function promptText(app: App, title: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    const modal = new PromptModal(app, title, defaultValue, resolve);
    modal.open();
  });
}

class PromptModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private defaultValue: string,
    private onSubmit: (value: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });
    const input = contentEl.createEl('input', {
      cls: 'ct-prompt-input',
      attr: { type: 'text', value: this.defaultValue },
    });
    input.style.width = '100%';
    input.focus();
    input.select();

    const submit = () => {
      this.onSubmit(input.value);
      this.close();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') {
        this.onSubmit(this.defaultValue);
        this.close();
      }
    });

    const btn = contentEl.createEl('button', { text: 'Create', cls: 'mod-cta' });
    btn.style.marginTop = '8px';
    btn.addEventListener('click', submit);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

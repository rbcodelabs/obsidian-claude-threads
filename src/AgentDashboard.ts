import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread } from './types';

export const AGENT_VIEW_TYPE = 'claude-threads:agents';

type RowState = 'running' | 'idle' | 'error' | 'empty';

export class AgentDashboard extends ItemView {
  private plugin: ClaudeThreadsPlugin;
  private manager: ThreadManager;
  private unsubscribe: (() => void) | null = null;

  private listEl!: HTMLElement;
  private headerCountEl!: HTMLElement;
  private dispatchInput!: HTMLTextAreaElement;

  // Per-row activity text elements for live update without full re-render
  private activityEls: Map<string, HTMLElement> = new Map();
  private timeEls: Map<string, HTMLElement> = new Map();

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
    this.dispatchInput = dispatchEl.createEl('textarea', {
      cls: 'ct-agents-dispatch-input',
      attr: { placeholder: 'Dispatch a task... (Enter to start, Shift+Enter for newline)' },
    });
    const dispatchBtn = dispatchEl.createEl('button', {
      cls: 'ct-agents-dispatch-btn',
      text: 'Start',
    });
    dispatchBtn.addEventListener('click', () => this.dispatch());
    this.dispatchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.dispatch();
      }
    });
  }

  private handleEvent(threadId: string, event: ThreadEvent): void {
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

    const threads = this.manager.getThreads();
    const running: Thread[] = [];
    const idle: Thread[] = [];
    const errors: Thread[] = [];
    const empty: Thread[] = [];

    for (const t of threads) {
      if (this.manager.isRunning(t.id)) running.push(t);
      else if (t.lastError) errors.push(t);
      else if (t.messages.length > 0) idle.push(t);
      else empty.push(t);
    }

    if (threads.length === 0) {
      const emptyEl = this.listEl.createDiv('ct-agents-empty');
      emptyEl.createDiv({ text: 'No threads yet.' });
      emptyEl.createDiv({ cls: 'ct-agents-empty-sub', text: 'Use the dispatch input below to start a task.' });
    }

    if (running.length > 0) this.renderGroup('Working', running, 'running');
    if (idle.length > 0) this.renderGroup('Completed', idle, 'idle');
    if (errors.length > 0) this.renderGroup('Failed', errors, 'error');
    if (empty.length > 0) this.renderGroup('Ready', empty, 'empty');

    this.updateHeader(threads.length, running.length);
  }

  private renderGroup(label: string, threads: Thread[], state: RowState): void {
    const group = this.listEl.createDiv('ct-agents-group');
    group.createDiv({ cls: 'ct-agents-group-label', text: label });
    for (const thread of threads) {
      this.renderRow(thread, state, group);
    }
  }

  private renderRow(thread: Thread, state: RowState, parent: HTMLElement): void {
    const row = parent.createDiv({ cls: `ct-agents-row ct-agents-row-${state}` });

    const iconEl = row.createDiv('ct-agents-icon');
    this.applyStateIcon(iconEl, state);

    const body = row.createDiv('ct-agents-row-body');
    body.createDiv({ cls: 'ct-agents-row-title', text: thread.title });
    const activityEl = body.createDiv({ cls: 'ct-agents-row-activity' });
    activityEl.setText(this.getActivityText(thread, state));
    this.activityEls.set(thread.id, activityEl);

    const meta = row.createDiv('ct-agents-row-meta');
    const timeEl = meta.createDiv({ cls: 'ct-agents-row-time', text: relativeTime(thread.updatedAt) });
    this.timeEls.set(thread.id, timeEl);
    if (thread.cwd) {
      meta.createDiv({ cls: 'ct-agents-row-cwd', text: shortenPath(thread.cwd) });
    }

    row.addEventListener('click', () => this.plugin.openThreadInChatView(thread.id));
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
    const summary = thread.summary || thread.recap;
    if (summary) return summary.slice(0, 100);
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

  private async dispatch(): Promise<void> {
    const text = this.dispatchInput.value.trim();
    if (text.length < 2) return;
    this.dispatchInput.value = '';
    await this.plugin.dispatchNewThread(text);
    this.render();
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) p = '~' + p.slice(home.length);
  const parts = p.split('/');
  return parts.length > 4 ? '~/' + parts.slice(-2).join('/') : p;
}

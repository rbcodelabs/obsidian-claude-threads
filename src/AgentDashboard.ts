import { ItemView, WorkspaceLeaf, setIcon, Notice } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread } from './types';
import { buildMessageWithAttachment, deriveDispatchTitle } from './attachmentUtils';
import { formatToolName } from './ClaudeSession';
import { relativeTime, buildCwdLabel, isAwsSsoError, extractAwsProfile } from './dashboardUtils';
import { DispatchInput } from './DispatchInput';

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
  private dispatchComponent!: DispatchInput;

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
    this.dispatchComponent?.destroy();
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-agents-root');
    root.addClass('ct-dashboard-root');

    // Scrollable thread list — padding-bottom leaves clearance for the floating panel
    this.listEl = root.createDiv('ct-agents-list');

    // Floating panel anchored at the bottom (matches ThreadsView pattern)
    const panel = root.createDiv('ct-floating-panel ct-agents-floating-panel');

    // Meta strip: thread count (left) + action buttons (right)
    const metaRow = panel.createDiv('ct-agents-panel-meta');
    this.headerCountEl = metaRow.createDiv('ct-agents-count');
    const metaActions = metaRow.createDiv('ct-agents-panel-actions');

    this.searchBtn = metaActions.createEl('button', {
      cls: 'ct-agents-search-btn clickable-icon',
      attr: { title: 'Search threads', 'aria-label': 'Search threads' },
    });
    setIcon(this.searchBtn, 'search');
    this.searchBtn.addEventListener('click', () => this.toggleSearch());

    const kanbanBtn = metaActions.createEl('button', {
      cls: 'ct-kanban-toggle clickable-icon',
      attr: { title: 'Open Kanban Board', 'aria-label': 'Open Kanban Board' },
    });
    setIcon(kanbanBtn, 'layout-grid');
    kanbanBtn.addEventListener('click', () => {
      this.plugin.activateKanbanView();
    });

    // Search bar — hidden by default, expands inside the panel when toggled
    this.searchBarEl = panel.createDiv('ct-agents-search-bar ct-hidden');
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

    // Dispatch input — mounted inside the floating panel
    const dispatchEl = panel.createDiv();
    this.dispatchComponent = new DispatchInput({
      app: this.app,
      placeholder: 'Dispatch a task...',
      builtinCommands: [
        { name: 'compact', description: 'Summarize conversation history to free up context' },
        { name: 'clear', description: 'Clear conversation history and start fresh' },
        { name: 'cost', description: 'Show token usage and cost for this session' },
        { name: 'model', description: 'Set persistent model: /model opus|sonnet|haiku|default' },
      ],
      onSend: async ({ text, images, attachment }) => {
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
              } catch { /* skip */ }
            }
          }
          if (fileContextParts.length > 0) {
            messageText = messageText + '\n\n---\nReferenced files:\n\n' + fileContextParts.join('\n\n');
          }
        }

        const titleHint = deriveDispatchTitle(text, attachment, images.length);
        const threadId = await this.plugin.dispatchNewThread(
          messageText,
          images.length > 0 ? images : undefined,
          titleHint,
        );
        await this.plugin.openThreadInChatView(threadId);
        this.render();
      },
      getPttKey: () => this.plugin.settings.pttKey ?? '',
      captureLongPaste: true,
      // Empty callback forces needsFooter=true so attach+mic land in the footer
      // row (matching the conversation panel layout). No "more" button needed here.
      appendFooterActions: () => {},
    });
    this.dispatchComponent.mount(dispatchEl);
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
      event.type === 'thread_created' ||
      event.type === 'summary_updated';
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

    if (thread.cwd) {
      body.createDiv({ cls: 'ct-agents-row-cwd', text: buildCwdLabel(thread.cwd, this.plugin.manager.vaultRoot) });
    }

    const meta = row.createDiv('ct-agents-row-meta');
    const timeEl = meta.createDiv({ cls: 'ct-agents-row-time', text: relativeTime(thread.updatedAt) });
    this.timeEls.set(thread.id, timeEl);

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

  /** Focus the dispatch input so the user can type a task immediately. */
  public focusDispatchInput(): void {
    this.dispatchComponent?.focus();
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

}


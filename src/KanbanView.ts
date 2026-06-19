import { ItemView, WorkspaceLeaf, setIcon, Notice } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread } from './types';
import { formatToolName } from './ClaudeSession';
import { relativeTime, buildCwdLabel, isAwsSsoError, extractAwsProfile, resolveAwsBinary, awsExecEnv } from './dashboardUtils';
import { resolveProjectName } from './pathUtils';
import { DispatchInput } from './DispatchInput';
import { DISPATCH_BUILTIN_COMMANDS, DISPATCH_ARG_COMPLETIONS, parseDispatchDirective, goalKickoffMessage } from './slashCommands';
import { buildMessageWithAttachment, deriveDispatchTitle } from './attachmentUtils';

export const KANBAN_VIEW_TYPE = 'claude-threads:kanban';

type RowState = 'running' | 'idle' | 'error' | 'empty';

type ColDef = { label: string; threads: Thread[]; state: RowState; accentClass?: string; badge?: number };

/** Group key + display label for a thread's app/project, used by folder grouping. */
const UNASSIGNED_GROUP = 'Unassigned';

export class KanbanView extends ItemView {
  private plugin: ClaudeThreadsPlugin;
  private manager: ThreadManager;
  private unsubscribe: (() => void) | null = null;

  private boardEl!: HTMLElement;
  private headerCountEl!: HTMLElement;
  private searchBarEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private searchClearBtn!: HTMLButtonElement;
  private searchBtn!: HTMLButtonElement;
  private groupByBtn!: HTMLButtonElement;
  private searchQuery = '';

  // Per-card live-update elements
  private activityEls: Map<string, HTMLElement> = new Map();
  private timeEls: Map<string, HTMLElement> = new Map();
  private rowEls: Map<string, HTMLElement> = new Map();
  private activeThreadId: string | null = null;

  private renderPending = false;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private timeInterval: ReturnType<typeof setInterval> | null = null;
  private dispatchInput!: DispatchInput;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeThreadsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.manager = plugin.manager;
  }

  getViewType(): string { return KANBAN_VIEW_TYPE; }
  getDisplayText(): string { return 'Kanban Board'; }
  getIcon(): string { return 'layout-grid'; }

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
    this.dispatchInput?.destroy();
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-agents-root');

    this.boardEl = root.createDiv('ct-agents-list');

    // Floating dispatch panel — centered at bottom of the board
    const dispatchWrapper = root.createDiv('ct-kanban-dispatch ct-panel-collapsible');

    // Meta strip: thread count (left) + search button (right)
    const metaRow = dispatchWrapper.createDiv('ct-agents-panel-meta');
    this.headerCountEl = metaRow.createDiv('ct-agents-count');
    const metaActions = metaRow.createDiv('ct-agents-panel-actions');

    this.groupByBtn = metaActions.createEl('button', {
      cls: 'ct-kanban-groupby clickable-icon',
    });
    this.groupByBtn.addEventListener('click', () => this.toggleGroupBy());
    this.updateGroupByBtn();

    this.searchBtn = metaActions.createEl('button', {
      cls: 'ct-agents-search-btn clickable-icon',
      attr: { title: 'Search threads', 'aria-label': 'Search threads' },
    });
    setIcon(this.searchBtn, 'search');
    this.searchBtn.addEventListener('click', () => this.toggleSearch());

    // Search bar — hidden by default, expands inside the panel when toggled
    this.searchBarEl = dispatchWrapper.createDiv('ct-agents-search-bar ct-hidden');
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

    this.dispatchInput = new DispatchInput({
      app: this.app,
      placeholder: 'Dispatch a new task',
      inlineLayout: true,
      builtinCommands: DISPATCH_BUILTIN_COMMANDS,
      argCompletions: DISPATCH_ARG_COMPLETIONS,
      onSend: async ({ text, images, attachment }) => {
        // Intercept leading built-in commands (/model, /goal, /loop) — apply
        // them to the new thread instead of sending the text to Claude verbatim.
        let dispatchOpts: { model?: string; goal?: string; loop?: { intervalSeconds: number } } | undefined;
        let titleText = text;
        const directive = parseDispatchDirective(text);
        if (directive) {
          if (directive.error) {
            new Notice(directive.error);
            this.dispatchInput.setValue(text);
            return;
          }
          if (directive.kind === 'model') {
            if (!directive.rest && images.length === 0 && !attachment) {
              new Notice('Include a prompt after /model — e.g. "/model opus fix the login bug"');
              this.dispatchInput.setValue(text);
              return;
            }
            dispatchOpts = { model: directive.model };
            text = titleText = directive.rest;
          } else if (directive.kind === 'goal') {
            dispatchOpts = { goal: directive.goal };
            text = goalKickoffMessage(directive.goal);
            titleText = directive.goal;
          } else {
            dispatchOpts = { loop: { intervalSeconds: directive.intervalSeconds } };
            text = titleText = directive.prompt;
          }
        }

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

        const titleHint = deriveDispatchTitle(titleText, attachment, images.length);
        const threadId = await this.plugin.dispatchNewThread(
          messageText,
          images.length > 0 ? images : undefined,
          titleHint,
          dispatchOpts,
        );
        await this.plugin.openThreadInChatView(threadId);
      },
      getPttKey: () => this.plugin.settings.pttKey ?? '',
    });
    this.dispatchInput.mount(dispatchWrapper);
  }

  private toggleSearch(): void {
    const hidden = this.searchBarEl.hasClass('ct-hidden');
    if (hidden) {
      this.searchBarEl.removeClass('ct-hidden');
      this.searchInputEl.focus();
      setIcon(this.searchBtn, 'x');
      this.searchBtn.setAttribute('title', 'Close search');
      this.searchBtn.setAttribute('aria-label', 'Close search');
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

  private get groupBy(): 'status' | 'folder' {
    return this.plugin.settings.kanbanGroupBy ?? 'status';
  }

  private updateGroupByBtn(): void {
    const byFolder = this.groupBy === 'folder';
    setIcon(this.groupByBtn, byFolder ? 'folder-tree' : 'columns-3');
    this.groupByBtn.toggleClass('ct-kanban-groupby-active', byFolder);
    const label = byFolder ? 'Grouping by folder — click to group by status' : 'Group by folder';
    this.groupByBtn.setAttribute('title', label);
    this.groupByBtn.setAttribute('aria-label', label);
  }

  private async toggleGroupBy(): Promise<void> {
    this.plugin.settings.kanbanGroupBy = this.groupBy === 'folder' ? 'status' : 'folder';
    await this.plugin.saveSettings();
    this.updateGroupByBtn();
    this.render();
  }

  render(): void {
    const scrollLeft = this.boardEl.scrollLeft;
    const scrollTop = this.boardEl.scrollTop;

    this.boardEl.empty();
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

    if (threads.length === 0) {
      const emptyEl = this.boardEl.createDiv('ct-agents-empty');
      if (q) {
        emptyEl.createDiv({ text: 'No threads match your search.' });
      } else {
        emptyEl.createDiv({ text: 'No threads yet.' });
        emptyEl.createDiv({ cls: 'ct-agents-empty-sub', text: 'Use the dispatch input below to start a task.' });
      }
      this.updateHeader(0, 0);
      return;
    }

    if (this.groupBy === 'folder') {
      this.renderFolderBoard(threads);
    } else {
      this.renderStatusBoard(threads);
    }

    const runningCount = threads.filter(t => this.manager.isRunning(t.id)).length;
    this.updateHeader(threads.length, runningCount);

    this.boardEl.scrollLeft = scrollLeft;
    this.boardEl.scrollTop = scrollTop;
  }

  /**
   * Buckets threads into the six status columns and sorts each by recency.
   * Shared by both the status board and each folder swimlane.
   */
  private bucketize(threads: Thread[]): ColDef[] {
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

    return [
      { label: 'Working', threads: running, state: 'running' },
      { label: 'Awaiting', threads: permReqs, state: 'running', accentClass: 'ct-kanban-col-permission' },
      { label: 'New', threads: unreviewed, state: 'idle', badge: unreviewed.length > 0 ? unreviewed.length : undefined },
      { label: 'Done', threads: reviewed, state: 'idle' },
      { label: 'Failed', threads: errors, state: 'error' },
      { label: 'Ready', threads: empty, state: 'empty' },
    ];
  }

  private renderStatusBoard(threads: Thread[]): void {
    const board = this.boardEl.createDiv('ct-kanban-board');
    const cols = this.bucketize(threads);
    for (const col of cols) {
      const alwaysShow = col.label === 'Working' || col.label === 'New';
      if (!alwaysShow && col.threads.length === 0) continue;
      this.renderColumn(board, col.label, col.threads, col.state, col.accentClass, col.badge);
    }
  }

  /**
   * Groups threads by app/project (assigned Project name, falling back to a
   * working-directory label) and renders one horizontal swimlane per group.
   * Within each lane the threads are bucketed into the same status columns;
   * empty columns are omitted to keep lanes compact.
   */
  private renderFolderBoard(threads: Thread[]): void {
    const board = this.boardEl.createDiv('ct-kanban-board ct-kanban-swimlanes');

    const groups = new Map<string, Thread[]>();
    for (const t of threads) {
      const key = this.groupLabel(t);
      const bucket = groups.get(key);
      if (bucket) bucket.push(t);
      else groups.set(key, [t]);
    }

    // Sort lanes alphabetically (case-insensitive) so they stay put as threads
    // update — the last-modified sort happens WITHIN each lane (per status column
    // in bucketize), not across lanes. The catch-all group always sinks last.
    const lanes = Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === UNASSIGNED_GROUP) return 1;
      if (b[0] === UNASSIGNED_GROUP) return -1;
      return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
    });

    for (const [label, laneThreads] of lanes) {
      const lane = board.createDiv('ct-kanban-lane');

      const header = lane.createDiv('ct-kanban-lane-header');
      const titleSpan = header.createSpan('ct-kanban-lane-title');
      const iconSpan = titleSpan.createSpan('ct-kanban-lane-icon');
      setIcon(iconSpan, label === UNASSIGNED_GROUP ? 'folder-minus' : 'folder');
      titleSpan.createSpan({ cls: 'ct-kanban-lane-name', text: label });
      header.createSpan({ cls: 'ct-kanban-lane-count', text: String(laneThreads.length) });

      const laneBoard = lane.createDiv('ct-kanban-lane-board');
      const cols = this.bucketize(laneThreads);
      for (const col of cols) {
        if (col.threads.length === 0) continue;
        this.renderColumn(laneBoard, col.label, col.threads, col.state, col.accentClass, col.badge);
      }
    }
  }

  /**
   * The app/project label a thread belongs to when grouping by folder:
   * the assigned Project's name, else the thread's git repo / project name,
   * else the Unassigned catch-all.
   *
   * Uses the repo NAME (resolveProjectName) rather than buildCwdLabel so that
   * every worktree of a repo collapses into a single lane — e.g. a main checkout
   * and its `feat-x` / temp worktrees all group under "my-repo" instead of
   * appearing as separate "my-repo · feat-x" lanes. Each card still shows its own
   * branch/worktree via the cwd chip in the footer.
   */
  private groupLabel(thread: Thread): string {
    if (thread.projectId) {
      const project = this.manager.getProject(thread.projectId);
      if (project) return project.name;
    }
    if (thread.cwd) {
      const repo = resolveProjectName(thread.cwd);
      if (repo) return repo;
      // Fallback for non-repo paths (resolveProjectName already returns the last
      // path segment, but guard anyway): shortened cwd label.
      const label = buildCwdLabel(thread.cwd, this.manager.vaultRoot);
      if (label) return label;
    }
    return UNASSIGNED_GROUP;
  }

  private renderColumn(
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
      this.renderCard(thread, state, body);
    }
  }

  private renderCard(thread: Thread, state: RowState, parent: HTMLElement): void {
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
      this.applyStateIcon(iconEl, state);
    }
    cardHeader.createDiv({ cls: 'ct-kanban-card-title', text: thread.title });

    // Summary (idle threads only)
    const summary = thread.summary || thread.recap;
    if (summary && state === 'idle') {
      card.createDiv({ cls: 'ct-kanban-card-summary', text: summary });
    }

    // Task list (compact checklist from Claude Code's TodoWrite/TaskCreate)
    const tasks = thread.tasks;
    if (tasks && tasks.length > 0) {
      const completedCount = tasks.filter(t => t.status === 'completed').length;
      const taskSection = card.createDiv('ct-kanban-tasks');

      taskSection.createDiv({
        cls: 'ct-kanban-tasks-progress',
        text: `${completedCount} / ${tasks.length} done`,
      });

      const STATUS_ICONS: Record<string, string> = {
        completed: '✔',
        in_progress: '■',
        pending: '○',
      };
      const MAX_TASKS = 5;
      const visibleTasks = tasks.slice(0, MAX_TASKS);
      for (const task of visibleTasks) {
        const row = taskSection.createDiv(`ct-kanban-task-row ct-task-row-${task.status}`);
        row.createSpan({ cls: 'ct-kanban-task-icon', text: STATUS_ICONS[task.status] ?? '○' });
        const label = task.content.length > 60 ? task.content.slice(0, 60) + '…' : task.content;
        row.createSpan({ cls: 'ct-kanban-task-text', text: label });
      }

      if (tasks.length > MAX_TASKS) {
        taskSection.createDiv({
          cls: 'ct-kanban-tasks-more',
          text: `+${tasks.length - MAX_TASKS} more`,
        });
      }
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
            const awsBin = resolveAwsBinary();
            const cmd = profile ? `${awsBin} sso login --profile ${profile}` : `${awsBin} sso login`;
            await new Promise<void>((resolve, reject) => {
              exec(cmd, { env: awsExecEnv() }, (err, _stdout, stderr) => {
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
      footer.createDiv({ cls: 'ct-kanban-chip ct-kanban-chip-cwd', text: buildCwdLabel(thread.cwd, this.plugin.manager.vaultRoot) });
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

  private applyStateIcon(el: HTMLElement, state: RowState): void {
    el.className = `ct-kanban-card-icon ct-kanban-icon-${state}`;
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

  private handleEvent(threadId: string, event: ThreadEvent): void {
    if (event.type === 'active_thread_changed') {
      this.setActiveCard(threadId);
      return;
    }
    if (event.type === 'permission_request' || event.type === 'permission_resolved') {
      this.scheduleRender();
      return;
    }
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
      event.type === 'summary_updated' ||
      event.type === 'status_tags' ||
      event.type === 'tasks_updated' ||
      event.type === 'task_updated';
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

  private setActiveCard(threadId: string): void {
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
}

import { ItemView, WorkspaceLeaf, setIcon, Notice } from 'obsidian';
import type ClaudeThreadsPlugin from './main';
import type { ThreadManager, ThreadEvent } from './ThreadManager';
import type { Thread } from './types';
import { buildMessageWithAttachment, deriveDispatchTitle } from './attachmentUtils';
import { formatToolName } from './ClaudeSession';
import { relativeTime, buildCwdLabel, isAwsSsoError, extractAwsProfile, resolveAwsBinary, awsExecEnv, formatWakeupCountdown } from './dashboardUtils';
import { DispatchInput } from './DispatchInput';
import { DISPATCH_BUILTIN_COMMANDS, DISPATCH_ARG_COMPLETIONS, parseDispatchDirective, goalKickoffMessage, escalationCommand } from './slashCommands';
import { partitionScheduledStacks, type ScheduledStack } from './scheduledStacks';
import { appendOrchestratorBadge } from './orchestrator-badge';
import { partitionThreads } from './threadRowState';

export const AGENT_VIEW_TYPE = 'claude-threads:agents';

type RowState = 'running' | 'waiting' | 'idle' | 'error' | 'empty';

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
  // Lightweight periodic sweep to pause spinners of wedged ("stale") running
  // threads within ~15s — faster than waiting on the 30s time refresh.
  private staleInterval: ReturnType<typeof setInterval> | null = null;

  /** IDs (Thread.scheduledItemId) of currently-expanded rows in the "Scheduled Jobs" section. */
  private expandedScheduledStacks = new Set<string>();

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
    this.staleInterval = setInterval(() => this.refreshStale(), 15_000);
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.timeInterval) clearInterval(this.timeInterval);
    if (this.staleInterval) clearInterval(this.staleInterval);
    this.dispatchComponent?.destroy();
  }

  /**
   * Toggles `.ct-stale` on each running row so styles.css pauses its spinner
   * once the thread has been `isRunning` with no progress for STALE_MS. Cheap
   * Map walk; safe to call on a short interval and on every render.
   */
  private refreshStale(): void {
    for (const [id, el] of this.rowEls) {
      el.toggleClass('ct-stale', this.manager.isRunStale(id));
    }
  }

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('ct-agents-root');
    root.addClass('ct-dashboard-root');

    // Scrollable thread list — padding-bottom leaves clearance for the floating panel
    this.listEl = root.createDiv('ct-agents-list');

    // Floating panel anchored at the bottom (matches ThreadsView pattern)
    const panel = root.createDiv('ct-floating-panel ct-agents-floating-panel ct-panel-collapsible');

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
      builtinCommands: () => {
        const esc = escalationCommand(this.plugin.settings, true);
        return esc ? [...DISPATCH_BUILTIN_COMMANDS, esc] : DISPATCH_BUILTIN_COMMANDS;
      },
      argCompletions: DISPATCH_ARG_COMPLETIONS,
      harnessPicker: { initialHarness: this.plugin.settings.agentHarness ?? 'claude' },
      onSend: async ({ text, images, attachment, agentHarness }) => {
        // Intercept leading built-in commands (/model, /goal, /loop) — apply
        // them to the new thread instead of sending the text to Claude verbatim.
        let dispatchOpts: { model?: string; goal?: string; loop?: { intervalSeconds: number }; agentHarness?: 'claude' | 'codex' } = { agentHarness };
        let titleText = text;
        const directive = parseDispatchDirective(
          text,
          this.plugin.settings.escalationEnabled ? this.plugin.settings.escalationKeyword : undefined,
        );
        if (directive) {
          if (directive.error) {
            new Notice(directive.error);
            this.dispatchComponent.setValue(text);
            return;
          }
          if (directive.kind === 'model') {
            if (!directive.rest && images.length === 0 && !attachment) {
              new Notice('Include a prompt after /model — e.g. "/model opus fix the login bug"');
              this.dispatchComponent.setValue(text);
              return;
            }
            dispatchOpts = { ...dispatchOpts, model: directive.model };
            text = titleText = directive.rest;
          } else if (directive.kind === 'goal') {
            dispatchOpts = { ...dispatchOpts, goal: directive.goal };
            text = goalKickoffMessage(directive.goal);
            titleText = directive.goal;
          } else if (directive.kind === 'loop') {
            dispatchOpts = { ...dispatchOpts, loop: { intervalSeconds: directive.intervalSeconds } };
            text = titleText = directive.prompt;
          }
          // 'escalate' directives always carry `error` (handled above) — no
          // success case, so nothing to do here; fall through to dispatch
          // the raw text as-is via the ThreadManager keyword path.
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
    if (event.type === 'threads_loaded') {
      this.scheduleRender();
      return;
    }
    if (event.type === 'active_thread_changed') {
      this.setActiveRow(threadId);
      return;
    }
    if (
      event.type === 'permission_request' ||
      event.type === 'permission_resolved' ||
      event.type === 'question_ready' ||
      event.type === 'pending_question_changed'
    ) {
      this.scheduleRender();
      return;
    }
    // A wake-up was registered, fired, or cancelled — re-partition so the
    // thread moves into/out of the "Waiting" group.
    if (event.type === 'wakeup_changed') {
      this.scheduleRender();
      return;
    }
    // The session generation has fully unwound and isRunning() has reached
    // its final settled value — re-partition so a thread with a pending
    // wake-up doesn't stay stuck under "Working" until an unrelated re-render.
    if (event.type === 'run_state_settled') {
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
      event.type === 'summary_updated' ||
      event.type === 'agent_runs_changed' ||
      event.type === 'status_tags';
    if (isStateChange) {
      this.scheduleRender();
      return;
    }
    // A background (skipTranscript) task — a `run_in_background: true` Agent
    // call, or a Workflow-tool task — resolved. This is the only place a
    // thread that's sitting in "Working" purely because of an outstanding
    // background task moves back out once that task's last one finishes;
    // `done`/`run_state_settled` already correctly move it INTO that state
    // (scheduleRender() re-reads hasActiveBackgroundTasks live), but nothing
    // previously re-checked when the background side of things settled.
    if (event.type === 'task_notification') {
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
      // Keep the activity line updating from subagent/workflow progress even
      // after the outer turn's own isRunning() has gone false — onTaskProgress
      // writes into threadActivity regardless of foreground/background state.
      if (el && (this.manager.isRunning(threadId) || this.manager.hasActiveBackgroundTasks(threadId))) {
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
          (t.recap ?? '').toLowerCase().includes(q) ||
          this.manager.getAgentRuns(t.id).some(agent =>
            `${agent.role ?? ''} ${agent.description} ${agent.currentActivity ?? ''}`.toLowerCase().includes(q)
          )
        )
      : allThreads;
    const buckets = partitionThreads(threads, (t) => ({
      isRunning: this.manager.isRunning(t.id),
      hasPendingPermission: this.manager.hasPendingPermission(t.id) || this.manager.hasPendingQuestion(t.id) || this.manager.hasPendingPlan(t.id),
      hasActiveBackgroundTasks: this.manager.hasActiveBackgroundTasks(t.id),
      hasPendingWakeup: this.plugin.hasPendingWakeup(t.id),
      lastError: t.lastError,
      messageCount: t.messages.length,
      reviewed: t.reviewed,
    }));
    // No separate "Awaiting" column exists on this dashboard (unlike Kanban) —
    // a permission/question request keeps the row under "Working" and is
    // surfaced instead via the per-row "?" treatment inside renderRow(),
    // which checks hasPendingPermission/hasPendingQuestion live at render time.
    const running: Thread[] = [...buckets.running, ...buckets.awaiting];
    const waiting: Thread[] = buckets.waiting;
    let unreviewed: Thread[] = buckets['idle-new'];
    let reviewed: Thread[] = buckets['idle-reviewed'];
    const errors: Thread[] = buckets.error;
    let empty: Thread[] = buckets.empty;

    // Sort each group by most recently updated first
    const byRecency = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;
    running.sort(byRecency);
    waiting.sort(byRecency);
    unreviewed.sort(byRecency);
    reviewed.sort(byRecency);
    errors.sort(byRecency);
    empty.sort(byRecency);

    // Pull "quiet" scheduled-job runs (unreviewed / reviewed / empty only —
    // running, waiting, and errored runs always stay in their normal group,
    // untouched) into a separate rollup section so a busy hourly job doesn't
    // bury manually-created threads. Gated behind a setting; disabled it's a
    // no-op and the dashboard behaves exactly as it did before this existed.
    let scheduledStacks: ScheduledStack[] = [];
    if (this.plugin.settings.stackScheduledThreads ?? true) {
      const scheduledQuiet = [...unreviewed, ...reviewed, ...empty].filter(t => t.scheduledItemId);
      unreviewed = unreviewed.filter(t => !t.scheduledItemId);
      reviewed = reviewed.filter(t => !t.scheduledItemId);
      empty = empty.filter(t => !t.scheduledItemId);
      // minCount=1: every distinct job gets its own row even with only one
      // quiet run right now, so the section doesn't pop in/out of existence.
      scheduledStacks = partitionScheduledStacks(scheduledQuiet, 1).stacks
        .sort((a, b) => b.threads[0].updatedAt - a.threads[0].updatedAt);
    }

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
    if (waiting.length > 0) this.renderGroup('Waiting', waiting, 'waiting');
    if (unreviewed.length > 0) this.renderGroup('New', unreviewed, 'idle', unreviewed.length);
    if (reviewed.length > 0) this.renderGroup('Reviewed', reviewed, 'idle');
    if (errors.length > 0) this.renderGroup('Failed', errors, 'error');
    if (empty.length > 0) this.renderGroup('Ready', empty, 'empty');
    if (scheduledStacks.length > 0) this.renderScheduledJobsGroup(scheduledStacks);

    this.updateHeader(threads.length, running.length);
  }

  /** Renders the "Scheduled Jobs" section — one collapsed rollup row per distinct cron job with quiet runs. Always last (least urgent content). */
  private renderScheduledJobsGroup(stacks: ScheduledStack[]): void {
    const group = this.listEl.createDiv('ct-agents-group');
    const labelEl = group.createDiv('ct-agents-group-label');
    labelEl.createSpan({ text: 'Scheduled Jobs' });
    for (const stack of stacks) {
      this.renderScheduledJobRow(stack, group);
    }
  }

  /**
   * Renders one collapsed-by-default row for a scheduled job's quiet runs:
   * job name, run count, latest-run relative time, and a chevron that
   * expands into one normal `renderRow()` per underlying thread.
   */
  private renderScheduledJobRow(stack: ScheduledStack, parent: HTMLElement): void {
    const key = stack.scheduledItemId;
    const expanded = this.expandedScheduledStacks.has(key);

    const row = parent.createDiv('ct-agents-row ct-agents-row-scheduled-stack');
    const iconEl = row.createDiv('ct-agents-icon ct-agents-icon-scheduled');
    setIcon(iconEl, 'clock');

    const body = row.createDiv('ct-agents-row-body');
    const titleRow = body.createDiv('ct-agents-stack-title-row');
    titleRow.createSpan({ cls: 'ct-agents-row-title', text: stack.scheduledItemName });
    titleRow.createSpan({ cls: 'ct-agents-group-badge ct-agents-stack-count', text: `×${stack.threads.length}` });
    body.createDiv({ cls: 'ct-agents-row-activity', text: `Last run ${relativeTime(stack.threads[0].updatedAt)}` });

    const chevron = row.createDiv('ct-expand-btn');
    setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.expandedScheduledStacks.has(key)) this.expandedScheduledStacks.delete(key);
      else this.expandedScheduledStacks.add(key);
      this.scheduleRender();
    });

    if (expanded) {
      const nested = parent.createDiv('ct-agents-stack-body');
      for (const thread of stack.threads) {
        this.renderRow(thread, thread.messages.length === 0 ? 'empty' : 'idle', nested);
      }
    }
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
    const hasPending = state === 'running' && (this.manager.hasPendingPermission(thread.id) || this.manager.hasPendingQuestion(thread.id));
    const row = parent.createDiv({
      cls: `ct-agents-row ct-agents-row-${state}${isActive ? ' ct-agents-row-active' : ''}${isUnreviewed ? ' ct-agents-row-unreviewed' : ''}${hasPending ? ' ct-agents-row-permission' : ''}`,
    });
    this.rowEls.set(thread.id, row);
    row.toggleClass('ct-stale', this.manager.isRunStale(thread.id));

    const iconEl = row.createDiv('ct-agents-icon');
    if (hasPending) {
      iconEl.addClass('ct-agents-icon-permission');
      iconEl.setText('?');
    } else {
      this.applyStateIcon(iconEl, state);
    }

    const body = row.createDiv('ct-agents-row-body');
    const titleEl = body.createDiv({ cls: 'ct-agents-row-title', text: thread.title });
    appendOrchestratorBadge(titleEl, thread.id, this.plugin.settings.orchestratorThreadId);

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

      // ── Scheduled wake-up: show a Cancel button ──────────────────────────
      if (state === 'waiting') {
        const btns = body.createDiv({ cls: 'ct-agents-wakeup-actions' });
        const cancel = btns.createEl('button', { text: 'Cancel', cls: 'ct-permission-btn ct-wakeup-cancel' });
        cancel.addEventListener('click', (e) => {
          e.stopPropagation();
          this.plugin.cancelWakeups(thread.id);
        });
      }

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

    if (thread.cwd) {
      body.createDiv({ cls: 'ct-agents-row-cwd', text: buildCwdLabel(thread.cwd, this.plugin.manager.vaultRoot) });
    }

    const agentRuns = this.manager.getAgentRuns(thread.id);
    if (agentRuns.length) {
      const tree = body.createDiv({ cls: 'ct-dashboard-agent-tree', attr: { role: 'tree', 'aria-label': `Agents in ${thread.title}` } });
      const byParent = new Map<string | undefined, typeof agentRuns>();
      for (const agent of agentRuns) {
        const key = agent.parentAgentRunId;
        const bucket = byParent.get(key) ?? []; bucket.push(agent); byParent.set(key, bucket);
      }
      const appendAgents = (host: HTMLElement, parentId?: string, level = 1) => {
        for (const agent of byParent.get(parentId) ?? []) {
          const button = host.createEl('button', { cls: `ct-dashboard-agent ct-agent-${agent.status}`, attr: { role: 'treeitem', 'aria-level': String(level), title: `Open ${agent.description}` } });
          button.createSpan({ cls: 'ct-agent-status-dot' });
          button.createSpan({ text: agent.role ?? agent.description });
          button.addEventListener('click', e => {
            e.stopPropagation(); this.manager.selectAgentRun(thread.id, agent.id); this.plugin.openThreadInChatView(thread.id);
          });
          appendAgents(host, agent.id, level + 1);
        }
      };
      appendAgents(tree);
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
      case 'waiting': el.setText('⏳'); break;
      case 'idle':    el.setText('✓'); break;
      case 'error':   el.setText('✗'); break;
      default:        el.setText('○'); break;
    }
  }

  private getActivityText(thread: Thread, state: RowState): string {
    if (state === 'running') {
      return this.manager.getThreadActivity(thread.id) || 'Working...';
    }
    if (state === 'waiting') {
      const next = this.plugin.getPendingWakeups(thread.id)[0];
      if (!next) return 'Waiting to resume';
      const when = formatWakeupCountdown(next.fireAt);
      return next.reason ? `Resumes ${when} — ${next.reason}` : `Resumes ${when}`;
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
    // Keep waiting-row countdowns roughly current without a full re-render.
    for (const [id, el] of this.activityEls) {
      if (!this.manager.isRunning(id) && this.plugin.hasPendingWakeup(id)) {
        const thread = this.manager.getThread(id);
        if (thread) el.setText(this.getActivityText(thread, 'waiting'));
      }
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

export type MessageRole = 'user' | 'assistant' | 'compact';

export type ThreadStatus = 'waiting' | 'active' | 'error' | 'archived' | 'reconnecting';

export type LayoutDensity = 'compact' | 'comfortable' | 'spacious';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageAttachment {
  base64: string;
  mediaType: ImageMediaType;
  name: string;
}

export interface AskQuestionOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export interface ToolCallRecord {
  name: string;
  summary: string;
  timestamp?: number;
  /** tool_use block id from the SDK, used to correlate tool_progress heartbeats. */
  toolUseId?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCallRecord[];
  cost?: number;
  compactTrigger?: 'auto' | 'manual';
  preTokens?: number;
  /** Images attached to this message (user role only). Stored as base64 for display. */
  images?: ImageAttachment[];
  /** AI-generated 1-sentence summary used in compressed view. */
  summary?: string;
  /** Images returned by tool results during this turn (e.g. Read on a PNG). */
  toolResultImages?: Array<{ mediaType: string; data: string }>;
}

export interface ThreadDraft {
  text: string;
  attachment: string | null;
  images: ImageAttachment[];
}

/**
 * A background task started during a session (Bash with run_in_background: true)
 * that hasn't received a completion notification yet.
 */
export interface PendingBackgroundTask {
  taskId: string;
  description: string;
  /** Epoch ms when the task was started. */
  startedAt: number;
  /** Number of times the plugin has polled for this task's status. */
  pollCount: number;
}

export type TaskItemStatus = 'pending' | 'in_progress' | 'completed';

/**
 * One entry in Claude Code's task list. Populated from TodoWrite (older CLIs,
 * full-list replace) or TaskCreate/TaskUpdate (newer CLIs, incremental).
 */
export interface TaskItem {
  id: string;
  content: string;
  status: TaskItemStatus;
}

/**
 * One pill in a thread's status-line footer, produced by the configured
 * statusLineCommand. Scripts may emit these as a JSON array; legacy plaintext
 * output is normalized into the same shape (see src/statusLine.ts).
 */
export interface StatusTag {
  /** Required display text, e.g. "PR #42", "main", "AWS ok". */
  label: string;
  /** If set, the pill is a link (opened via electron shell.openExternal). */
  url?: string;
  /** Lucide icon name. If omitted, derived from `kind` at render time. */
  icon?: string;
  /** Visual tone. Defaults to 'normal'. */
  tone?: 'normal' | 'warn' | 'error';
  /**
   * Semantic category. 'pr' drives prUrl derivation and the leading PR pill.
   * Open-ended so scripts can introduce new kinds without a plugin change.
   */
  kind?: 'pr' | 'branch' | 'dev' | 'aws' | string;
}

export interface Thread {
  id: string;
  sessionId?: string;
  title: string;
  cwd: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  noteFile?: string;
  /**
   * Vault-relative path to the raw JSONL conversation log for this thread
   * (e.g. "Claude/logs/<thread_id>.jsonl"). Append-only record of every raw
   * SDK event (tool calls with inputs, tool results, assistant messages,
   * usage/cost, system events) so agents can retrieve and analyze the full
   * transcript. Linked from the markdown note's `raw_log` frontmatter.
   */
  rawLogPath?: string;
  recap?: string;
  summary?: string;
  lastError?: string;
  /**
   * Auto-retry budget tracker for the closed-source CLI's spurious
   * "Stream closed" transport errors (see transportErrorRecovery.ts).
   * Reset to 0 on a successful onDone; incremented on each auto-retry.
   */
  streamCloseRetryCount?: number;
  model?: string;
  projectId?: string;
  reviewed?: boolean;
  /** Paths of files written or edited during this thread's lifetime. */
  editedFiles?: string[];
  /** Subset of editedFiles where the user modified the proposed content in the permission dialog. */
  userModifiedFiles?: string[];
  /** Unsent draft message and attachments for this thread. */
  draft?: ThreadDraft;
  /** Current lifecycle status of the thread. */
  status?: ThreadStatus;
  /**
   * URL of the GitHub PR associated with this thread (e.g. https://github.com/owner/repo/pull/42).
   * DERIVED from `statusTags` by StatusLineService (a tag with kind:'pr' or a /pull/N url).
   * Sticky: only overwritten when a poll yields a PR tag, never cleared on absence, so the
   * release archive-on-merge workflow can still match a thread after its PR merges.
   */
  prUrl?: string;
  /**
   * Status-line pills for this thread, populated by StatusLineService from the
   * configured statusLineCommand. Ephemeral — never persisted to data.json,
   * re-derived on the next poll. Undefined on mobile / when no script is set.
   */
  statusTags?: StatusTag[];
  /** Timestamp (ms epoch) of the last summarize call. Used by incremental summarization to identify messages added since the prior summary. */
  lastSummarizedAt?: number;
  /**
   * Set to true when the user has explicitly renamed this thread via the rename UI.
   * Prevents the auto-summarizer from overwriting a user-chosen title.
   * Threads that were never manually renamed (including those auto-titled from the
   * dispatch input's first message) leave this undefined/false so auto-title applies.
   */
  titleUserSet?: boolean;
  /**
   * Background tasks (Bash run_in_background: true) that started during a session
   * but didn't emit a task_notification before the stream ended. The plugin polls
   * these automatically and clears them when completions arrive.
   */
  pendingBackgroundTasks?: PendingBackgroundTask[];
  /**
   * Persistent goal set via the /goal command. Injected into the session's
   * appended system prompt on every turn until cleared with /goal clear.
   */
  goal?: string;
  /** Claude Code task list (TodoWrite / TaskCreate+TaskUpdate), rendered as a checklist card. */
  tasks?: TaskItem[];
  /**
   * When true, this thread is ephemeral: sessions are not persisted to disk
   * and the thread note is not saved to the vault.
   */
  ephemeral?: boolean;
  /**
   * Per-thread permission mode override. When set, takes precedence over the
   * global settings.permissionMode for sessions in this thread.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  /**
   * Plan text from a pending ExitPlanMode call that hasn't been approved or
   * rejected yet. Persisted so the plan card can be restored after a reload
   * or crash that killed the session mid-turn.
   */
  pendingPlan?: string;
}

/**
 * A Project groups related threads and scopes Claude's context to a specific
 * vault sub-folder. When a project is active, new threads use the project's
 * filesystem path as their working directory, giving Claude focused access to
 * just that folder's content.
 */
export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Vault-relative folder path (e.g. "Claude/my-project" or "Work/Acme"). */
  vaultFolder: string;
  /**
   * Optional explicit filesystem cwd override. When absent the plugin derives
   * the cwd automatically from vaultFolder + vault root.
   */
  cwdOverride?: string;
  createdAt: number;
}

export type ScheduleType = 'interval' | 'daily' | 'weekly';

export interface ScheduledItemSchedule {
  type: ScheduleType;
  /** For 'interval': seconds between runs (e.g. 3600 = hourly) */
  intervalSeconds?: number;
  /** For 'daily' and 'weekly': 24h time string e.g. "09:00" */
  timeOfDay?: string;
  /** For 'weekly': array of day numbers 0=Sun...6=Sat */
  daysOfWeek?: number[];
}

export interface ScheduledItem {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduledItemSchedule;
  enabled: boolean;
  /** Optional cwd override. Falls back to plugin default. */
  cwd?: string;
  /** Optional project ID for new threads */
  projectId?: string;
  /** Epoch ms of the last successful run */
  lastRun?: number;
  /** Epoch ms of the next scheduled run */
  nextRun?: number;
  /** Thread ID of the most recent run */
  lastThreadId?: string;
  /**
   * When set, fire the prompt into this existing thread instead of creating a
   * new one (used by the /loop command). Falls back to creating a new thread
   * if the target thread no longer exists.
   */
  targetThreadId?: string;
}

export interface SkillSource {
  /** Stable ID, generated as `crypto.randomUUID()` at creation time */
  id: string;
  /** Human-readable label, e.g. "Agentic PM Playbook" */
  name: string;
  /** 'github' = managed clone at ~/.claude/skill-sources/<id>; 'local' = user-provided path */
  type: 'github' | 'local';
  // ── github type fields ──────────────────────────────────────────────────────
  /** GitHub repo URL, e.g. "https://github.com/owner/repo" */
  repoUrl?: string;
  /** Absolute path to the managed clone, e.g. "/Users/foo/.claude/skill-sources/<id>" */
  clonePath?: string;
  /** ms epoch of the last git fetch (for staleness display) */
  lastFetched?: number;
  /** Commits behind remote (0 = up to date, undefined = not yet fetched) */
  behindCount?: number;
  // ── local type fields (legacy) ───────────────────────────────────────────────
  /** Absolute path (may use ~) to the directory containing skill subdirectories */
  skillsPath?: string;
  /** Optional: path to the git repo root, enables "Pull Updates" button */
  repoPath?: string;
}

export interface RemoteAccessSettings {
  enabled: boolean;
  /** 32-char hex string generated on first enable. Empty string when not yet generated. */
  roomId: string;
  relayUrl: string;
  /** Non-null only while actively pairing (the pairing code is the formatted roomId). */
  pairingCode: string | null;
  /** ms epoch at which the pairing code expires. */
  pairingExpiresAt: number | null;
}

/**
 * Which account/backend the Claude Code CLI authenticates against.
 * - 'claude': the CLI's own login (Claude.ai/Console subscription or ANTHROPIC_API_KEY)
 * - 'bedrock': Amazon Bedrock — sets CLAUDE_CODE_USE_BEDROCK=1 on every session;
 *   AWS credentials come from extra env vars (e.g. AWS_PROFILE + AWS_REGION)
 */
export type ProviderMode = 'claude' | 'bedrock';

export interface PluginSettings {
  claudeBinaryPath: string;
  defaultCwd: string;
  saveThreadsToVault: boolean;
  /**
   * When true, every thread's raw SDK event stream is appended to a JSONL log
   * at `<vaultFolder>/logs/<thread_id>.jsonl` and linked from the markdown
   * note's `raw_log` frontmatter. Independent of saveThreadsToVault so you can
   * keep raw logs without markdown notes, or vice versa. Defaults to true.
   */
  saveRawLogs: boolean;
  vaultFolder: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  /** Thinking mode for extended reasoning. 'disabled' sends no thinking param; 'adaptive' lets Claude decide; 'enabled' uses a fixed token budget. */
  thinkingMode: 'disabled' | 'adaptive' | 'enabled';
  /** Token budget for thinking when thinkingMode is 'enabled'. */
  thinkingBudgetTokens: number;
  /** Effort level passed to query(). 'default' omits the param. */
  effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** When true, subagents emit AI-generated progress summaries every ~30s. */
  agentProgressSummaries: boolean;
  /** When true, passes the context-1m-2025-08-07 beta header for 1M context window. */
  enable1MContext: boolean;
  extraEnv: string;
  /** Account/backend the Claude CLI authenticates against. Defaults to 'claude'. */
  provider: ProviderMode;
  /**
   * Model alias applied to threads that have no per-thread override
   * (set via /model). Empty string = let the CLI use its own default.
   * Accepts the same aliases as /model: fable, opus, sonnet, haiku.
   */
  defaultModel: string;
  summarizationEnabled: boolean;
  inprocessModel: string;
  autoSummarize: boolean;
  /** When the escalation keyword appears in a message, route that turn to escalationModel. */
  escalationEnabled: boolean;
  /** Keyword that triggers escalation for a single turn (stripped before sending). */
  escalationKeyword: string;
  /** Model alias the escalation keyword routes to (fable, opus, sonnet, haiku). */
  escalationModel: string;
  alwaysAllowedTools: string[];
  disallowedTools: string[];
  threads: Thread[];
  projects: Project[];
  wakeLockEnabled: boolean;
  layoutDensity: LayoutDensity;
  /**
   * Shell command for the context footer bar. Receives JSON on stdin with
   * {cwd, workspace:{current_dir}, branch} describing the thread. stdout may be
   * a JSON array of status tags (see StatusTag) or legacy plaintext (segments
   * split on 2+ spaces). Rendered as pills below the input area. Empty disables
   * it. Run per-thread by StatusLineService (desktop only).
   */
  statusLineCommand: string;
  /** How often (ms) StatusLineService polls the statusLineCommand per thread cwd. Default 30000. */
  statusLineIntervalMs?: number;
  remoteAccess: RemoteAccessSettings;
  /** When true, verbose operational logs (stream events, session lifecycle, relay connections) are emitted to the console. Off by default to keep long sessions clean. */
  debugLogging: boolean;
  /** Set to true after the first-run onboarding flow has completed. Prevents the welcome guide and panel auto-layout from triggering on subsequent loads. */
  hasSeenWelcome: boolean;
  /**
   * Hotkey for push-to-talk recording. Serialized as e.g. "Alt+Space" or "Control+Shift+Space".
   * Empty string disables PTT. Default: "Alt+Space" (Option+Space on Mac).
   */
  pttKey: string;
  /** OpenAI API key used for Whisper speech-to-text. Stored in data.json (device-local). */
  openAIKey: string;
  /**
   * List of environment variable names whose values are stored securely in the OS
   * keychain via app.secretStorage under the key `ct-secret-<varName>`. Only the
   * names are persisted here — values never appear in data.json.
   */
  secretEnvKeys: string[];
  /**
   * Set to true after the orphaned-note archive scan has run at least once with
   * nothing left to clean up. Prevents a full vault file-read scan on every startup
   * once the one-time migration for pre-archive-on-close thread notes is complete.
   * Reset to false whenever crash recovery restores threads from vault notes.
   */
  orphanArchiveScanComplete?: boolean;
  /** Recurring scheduled tasks that fire prompts into new threads. */
  scheduledItems: ScheduledItem[];
  /**
   * How the Kanban board groups threads. 'status' (default) renders the six
   * status columns. 'folder' renders one horizontal swimlane per app/project
   * (by assigned Project, falling back to working-directory label), with the
   * status columns nested inside each lane.
   */
  kanbanGroupBy?: 'status' | 'folder';
  /**
   * Which sidebar panel(s) to auto-collapse when the Kanban board tab is
   * opened, and restore when it is closed. Defaults to 'none' (no change).
   * Useful for giving the wide Kanban board more horizontal room.
   */
  kanbanCollapseSide?: 'none' | 'left' | 'right' | 'both';
  /**
   * When true, the obsidian_open_url MCP tool is registered and available to Claude.
   * Only takes effect if the Obsidian Web Viewer core plugin is also enabled.
   * Defaults to true so the tool is available out of the box.
   */
  enableWebViewerTool?: boolean;
  /** Registered local skill collections browsable from the Skills Manager. */
  skillSources: SkillSource[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeBinaryPath: '/opt/homebrew/bin/claude',
  defaultCwd: '',
  saveThreadsToVault: true,
  saveRawLogs: true,
  vaultFolder: 'Claude',
  permissionMode: 'acceptEdits',
  thinkingMode: 'disabled',
  thinkingBudgetTokens: 8000,
  effort: 'default',
  agentProgressSummaries: true,
  enable1MContext: false,
  extraEnv: '',
  provider: 'claude',
  defaultModel: '',
  summarizationEnabled: true,
  inprocessModel: 'haiku',
  autoSummarize: false,
  escalationEnabled: true,
  escalationKeyword: '/escalate',
  escalationModel: 'opus',
  alwaysAllowedTools: [],
  disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'CronUpdate'],
  threads: [],
  projects: [],
  wakeLockEnabled: true,
  layoutDensity: 'comfortable',
  statusLineCommand: 'bash $HOME/claude-config/bin/statusline-command.sh',
  statusLineIntervalMs: 30_000,
  debugLogging: false,
  hasSeenWelcome: false,
  pttKey: 'Alt+Space',
  openAIKey: '',
  secretEnvKeys: [],
  remoteAccess: {
    enabled: false,
    roomId: '',
    relayUrl: 'wss://claude-threads-relay.rbcodelabs.workers.dev',
    pairingCode: null,
    pairingExpiresAt: null,
  },
  scheduledItems: [],
  enableWebViewerTool: true,
  kanbanGroupBy: 'status',
  kanbanCollapseSide: 'none',
  skillSources: [],
};

/**
 * Returns the extraEnv string with provider-specific variables prepended.
 * Prepending (not appending) means a user-supplied CLAUDE_CODE_USE_BEDROCK
 * line in extraEnv still wins, since parseExtraEnv lets later lines override.
 */
export function effectiveExtraEnv(
  settings: Pick<PluginSettings, 'extraEnv' | 'provider'>,
): string {
  if (settings.provider === 'bedrock') {
    return `CLAUDE_CODE_USE_BEDROCK=1\n${settings.extraEnv ?? ''}`;
  }
  return settings.extraEnv ?? '';
}

export function parseExtraEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return result;
}

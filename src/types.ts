export type MessageRole = 'user' | 'assistant' | 'compact';

export type ThreadStatus = 'waiting' | 'active' | 'error' | 'archived';

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
}

export interface ThreadDraft {
  text: string;
  attachment: string | null;
  images: ImageAttachment[];
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
  recap?: string;
  summary?: string;
  lastError?: string;
  model?: string;
  projectId?: string;
  reviewed?: boolean;
  /** Paths of files written or edited during this thread's lifetime. */
  editedFiles?: string[];
  /** Unsent draft message and attachments for this thread. */
  draft?: ThreadDraft;
  /** Current lifecycle status of the thread. */
  status?: ThreadStatus;
  /** URL of the most recent GitHub PR opened during this thread (e.g. https://github.com/owner/repo/pull/42). */
  prUrl?: string;
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

export interface PluginSettings {
  claudeBinaryPath: string;
  defaultCwd: string;
  saveThreadsToVault: boolean;
  vaultFolder: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions';
  extraEnv: string;
  summarizationEnabled: boolean;
  inprocessModel: string;
  autoSummarize: boolean;
  opusEscalationEnabled: boolean;
  opusEscalationKeyword: string;
  alwaysAllowedTools: string[];
  threads: Thread[];
  projects: Project[];
  wakeLockEnabled: boolean;
  layoutDensity: LayoutDensity;
  /**
   * Shell command for the context footer bar. Receives JSON on stdin with
   * {cwd, branch} describing the active thread. stdout is displayed as a
   * one-line status strip below the input area. Empty string disables it.
   */
  statusLineCommand: string;
  remoteAccess: RemoteAccessSettings;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeBinaryPath: '/opt/homebrew/bin/claude',
  defaultCwd: '',
  saveThreadsToVault: true,
  vaultFolder: 'Claude',
  permissionMode: 'acceptEdits',
  extraEnv: '',
  summarizationEnabled: true,
  inprocessModel: 'haiku',
  autoSummarize: false,
  opusEscalationEnabled: true,
  opusEscalationKeyword: '/opus',
  alwaysAllowedTools: [],
  threads: [],
  projects: [],
  wakeLockEnabled: true,
  layoutDensity: 'comfortable',
  statusLineCommand: 'bash $HOME/claude-config/bin/statusline-command.sh',
  remoteAccess: {
    enabled: false,
    roomId: '',
    relayUrl: 'wss://claude-threads-relay.rbcodelabs.workers.dev',
    pairingCode: null,
    pairingExpiresAt: null,
  },
};

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

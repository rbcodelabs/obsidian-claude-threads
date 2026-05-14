export type MessageRole = 'user' | 'assistant' | 'compact';

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

export interface PluginSettings {
  claudeBinaryPath: string;
  defaultCwd: string;
  saveThreadsToVault: boolean;
  vaultFolder: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions';
  extraEnv: string;
  summarizationEnabled: boolean;
  summarizationMode: 'endpoint' | 'inprocess';
  summarizationEndpoint: string;
  summarizationModel: string;
  inprocessModel: string;
  autoSummarize: boolean;
  opusEscalationEnabled: boolean;
  opusEscalationKeyword: string;
  alwaysAllowedTools: string[];
  threads: Thread[];
  projects: Project[];
  wakeLockEnabled: boolean;
  layoutDensity: LayoutDensity;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeBinaryPath: '/opt/homebrew/bin/claude',
  defaultCwd: '',
  saveThreadsToVault: true,
  vaultFolder: 'Claude',
  permissionMode: 'acceptEdits',
  extraEnv: '',
  summarizationEnabled: true,
  summarizationMode: 'inprocess',
  summarizationEndpoint: 'http://localhost:11434/v1/chat/completions',
  summarizationModel: 'llama3.2',
  inprocessModel: 'haiku',
  autoSummarize: false,
  opusEscalationEnabled: true,
  opusEscalationKeyword: '/opus',
  alwaysAllowedTools: [],
  threads: [],
  projects: [],
  wakeLockEnabled: true,
  layoutDensity: 'comfortable',
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

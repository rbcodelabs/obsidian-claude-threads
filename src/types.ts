export type MessageRole = 'user' | 'assistant' | 'compact';

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

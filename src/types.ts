export type MessageRole = 'user' | 'assistant';

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
  threads: Thread[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeBinaryPath: '/opt/homebrew/bin/claude',
  defaultCwd: '',
  saveThreadsToVault: true,
  vaultFolder: 'Claude',
  permissionMode: 'acceptEdits',
  extraEnv: '',
  summarizationEnabled: false,
  summarizationMode: 'inprocess',
  summarizationEndpoint: 'http://localhost:11434/v1/chat/completions',
  summarizationModel: 'llama3.2',
  inprocessModel: 'gemma-2-2b-it-q4f16_1-MLC',
  autoSummarize: false,
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

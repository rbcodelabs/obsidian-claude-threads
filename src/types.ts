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
}

export interface PluginSettings {
  claudeBinaryPath: string;
  defaultCwd: string;
  saveThreadsToVault: boolean;
  vaultFolder: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions';
  threads: Thread[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeBinaryPath: '/opt/homebrew/bin/claude',
  defaultCwd: '',
  saveThreadsToVault: true,
  vaultFolder: 'Claude',
  permissionMode: 'acceptEdits',
  threads: [],
};

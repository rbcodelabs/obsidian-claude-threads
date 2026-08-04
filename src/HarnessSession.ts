import type { McpServerConfig, Options, SdkBeta } from '@anthropic-ai/claude-agent-sdk';
import type { ImageAttachment } from './types';
import type { SessionCallbacks } from './ClaudeSession';

/** The stable, harness-neutral contract used by ThreadManager. */
export interface HarnessSession {
  readonly turnInFlight: boolean;
  readonly cwd: string | undefined;
  readonly hasPendingPermission: boolean;
  canIdleReap(): boolean;
  start(options: HarnessSessionOptions): Promise<void>;
  send(text: string, images?: ImageAttachment[]): void;
  interrupt(): Promise<void>;
  close(): void;
  setModel(model: string | undefined): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  getContextUsage(): Promise<import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse | null>;
}

/** Options every harness needs to execute a thread consistently. */
export interface HarnessSessionOptions {
  cwd: string;
  permissionMode: Options['permissionMode'];
  extraEnvRaw: string;
  resume?: string;
  callbacks: SessionCallbacks;
  additionalDirectories?: string[];
  model?: string;
  appendSystemPrompt?: string;
  secretEnv?: Record<string, string>;
  claude?: ClaudeHarnessOptions;
  codex?: CodexHarnessOptions;
}

/** Claude-only capabilities intentionally kept out of the shared contract. */
export interface ClaudeHarnessOptions {
  mcpServers?: Record<string, McpServerConfig>;
  disallowedTools?: string[];
  sessionOptions?: {
    thinking?: Options['thinking'];
    effort?: Options['effort'];
    agentProgressSummaries?: boolean;
    betas?: SdkBeta[];
    persistSession?: boolean;
    plugins?: import('@anthropic-ai/claude-agent-sdk').SdkPluginConfig[];
    agents?: Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>;
  };
}

/** Codex-specific transport settings; kept separate as its app-server grows. */
export interface CodexHarnessOptions {
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

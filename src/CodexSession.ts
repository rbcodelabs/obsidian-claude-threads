import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { ImageAttachment } from './types';
import { parseExtraEnv } from './types';
import type { SessionCallbacks } from './ClaudeSession';
import { resolveCodexPermissions, resolveDynamicToolApproval, type HarnessSessionOptions } from './HarnessSession';
import { mergeUsageSnapshot, normalizeCodexAccountUsage, normalizeCodexRateLimitResponse, normalizeCodexTokenUsage, type UsageSnapshot } from './Usage';
import { renderCodexAgentProfiles } from './AgentProfiles';

type CodexTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type CodexThreadTokenUsage = {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
};

type ContextUsage = import('@anthropic-ai/claude-agent-sdk').SDKControlGetContextUsageResponse;

const ENTER_PLAN_MODE_TOOL = {
  type: 'function',
  name: 'EnterPlanMode',
  description: 'Switch to a read-only planning turn before proposing implementation. Use this when the task needs investigation and an approved plan before changes.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

export function codexDynamicToolDefinitions(
  tools: NonNullable<NonNullable<HarnessSessionOptions['codex']>['dynamicTools']> = [],
): Array<{ type: 'function'; name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    ENTER_PLAN_MODE_TOOL,
    ...tools
      .filter((tool) => tool.name !== ENTER_PLAN_MODE_TOOL.name)
      .map((tool) => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
  ];
}

export function applyCodexResumeFallback(text: string, history: string | undefined, resumeFailed: boolean): string {
  return resumeFailed && history ? history + text : text;
}

export function codexDeveloperInstructions(options: HarnessSessionOptions): string | null {
  const profileInstructions = renderCodexAgentProfiles(options.codex?.agentProfiles ?? {});
  const parts = [options.appendSystemPrompt, profileInstructions].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** ThreadResumeParams supports overriding developer instructions on resume. */
export function codexResumeInstructions(options: HarnessSessionOptions): { developerInstructions: string | null } {
  return { developerInstructions: codexDeveloperInstructions(options) };
}

/** Convert Claude's process-transport MCP shapes to Codex config.toml keys. */
export function codexMcpServers(servers: NonNullable<HarnessSessionOptions['codex']>['mcpServers']): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!server || server.type === 'sdk') continue;
    if (server.type === 'http' || server.type === 'sse') {
      result[name] = {
        url: server.url,
        ...(server.headers ? { http_headers: server.headers } : {}),
        ...(server.timeout ? { tool_timeout_sec: server.timeout / 1000 } : {}),
      };
      continue;
    }
    result[name] = {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.timeout ? { tool_timeout_sec: server.timeout / 1000 } : {}),
    };
  }
  return result;
}

/** Translate Codex's cumulative token notification to the shared context card model. */
export function codexContextUsage(tokenUsage: CodexThreadTokenUsage, model: string): ContextUsage | null {
  const maxTokens = tokenUsage.modelContextWindow ?? 0;
  if (maxTokens <= 0) return null;
  const usage = tokenUsage.total;
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const output = Math.max(0, usage.outputTokens - (usage.reasoningOutputTokens ?? 0));
  const reasoning = Math.max(0, usage.reasoningOutputTokens ?? 0);
  const categories = [
    { name: 'Input', tokens: uncachedInput, color: '#4b9cd3' },
    { name: 'Cached input', tokens: cached, color: '#7cb9e8' },
    { name: 'Output', tokens: output, color: '#97c1e8' },
    { name: 'Reasoning', tokens: reasoning, color: '#b0cfe8' },
  ];
  const totalTokens = Math.max(0, usage.totalTokens);
  return {
    categories,
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage: Math.min(100, (totalTokens / maxTokens) * 100),
    gridRows: [],
    model,
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheWriteInputTokens ?? 0,
      cache_read_input_tokens: cached,
    },
  };
}

/**
 * Thin JSON-RPC client for `codex app-server --stdio`.
 *
 * The app-server is deliberately used instead of `codex exec`: it keeps a
 * durable Codex thread open, streams item deltas, and lets the host answer
 * approval requests.  The protocol is generated by the locally installed
 * Codex CLI, so payloads are kept structural here to remain compatible with
 * CLI releases without bundling a stale copy of its generated types.
 */
export class CodexSession {
  private process: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private options: HarnessSessionOptions | null = null;
  private codexThreadId: string | undefined;
  private _turnInFlight = false;
  private activeTurnId: string | undefined;
  private activeTurnMode: HarnessSessionOptions['permissionMode'] | undefined;
  private turnStartPromise: Promise<string | undefined> | null = null;
  private closed = true;
  /** App-server has one active turn per thread; retain follow-ups locally. */
  private queuedTurns: Array<{ text: string; images?: ImageAttachment[] }> = [];
  private latestContextUsage: ContextUsage | null = null;
  private latestUsage: UsageSnapshot | null = null;
  private activeModel = '';
  private pendingPlanText: string | null = null;
  private planTransitionRequested = false;
  private awaitingPlanApproval = false;
  private approvalTransitionInFlight = false;
  private announcedSubagents = new Set<string>();
  private activeSubagentTurns = new Map<string, string>();
  private resumeFallbackPending = false;

  constructor(private codexPath: string) {}

  get turnInFlight(): boolean { return this._turnInFlight; }
  get cwd(): string | undefined { return this.options?.cwd; }
  get hasPendingPermission(): boolean { return false; }
  canIdleReap(): boolean { return !this._turnInFlight && !this.awaitingPlanApproval; }

  async start(options: HarnessSessionOptions): Promise<void> {
    this.close();
    this.options = options;
    this.activeModel = options.model ?? '';
    this.latestContextUsage = null;
    this.latestUsage = null;
    this.announcedSubagents.clear();
    this.activeSubagentTurns.clear();
    this.resumeFallbackPending = false;
    this.planTransitionRequested = false;
    this.awaitingPlanApproval = false;
    this.closed = false;
    this.process = spawn(this.codexPath, ['app-server', '--stdio'], {
      cwd: options.cwd,
      env: { ...process.env, ...parseExtraEnv(options.extraEnvRaw), ...(options.secretEnv ?? {}) },
      stdio: 'pipe',
    });
    this.process.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString()));
    this.process.stderr.on('data', (chunk: Buffer) => console.warn('[ClaudeThreads] Codex app-server:', chunk.toString().trim()));
    this.process.on('error', (error) => this.failAll(error));
    this.process.on('exit', (code) => {
      if (!this.closed && code !== 0) this.failAll(new Error(`Codex app-server exited (${code ?? 'unknown'})`));
      this.closed = true;
    });

    await this.request('initialize', {
      clientInfo: { name: 'obsidian-claude-threads', title: 'Claude Threads', version: '0.24.0' },
      // runtimeWorkspaceRoots and dynamicTools are currently gated by the
      // app-server's experimental protocol capability.
      capabilities: { experimentalApi: true },
    });
    // The app-server follows the LSP-style two-phase handshake: it does not
    // accept thread requests until the client confirms initialization.
    this.notify('initialized');

    await this.loadInitialRateLimits();

    await this.registerSkillRoots();

    const savedCodexThread = options.resume;
    const mcpServers = codexMcpServers(options.codex?.mcpServers);
    const threadConfig = Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : undefined;
    let result: any;
    if (savedCodexThread) {
      try {
        result = await this.request('thread/resume', {
          threadId: savedCodexThread,
          cwd: options.cwd,
          runtimeWorkspaceRoots: options.additionalDirectories ?? [options.cwd],
          model: options.model ?? null,
          approvalPolicy: options.codex?.approvalPolicy ?? resolveCodexPermissions(options.permissionMode).approvalPolicy,
          sandbox: options.codex?.sandbox ?? resolveCodexPermissions(options.permissionMode).sandbox,
          config: threadConfig,
          ...codexResumeInstructions(options),
        });
      } catch (error) {
        this.resumeFallbackPending = true;
        console.warn('[ClaudeThreads] Could not resume Codex thread; starting a new one:', error);
      }
    }
    if (!result) {
      result = await this.request('thread/start', {
        cwd: options.cwd,
        runtimeWorkspaceRoots: options.additionalDirectories ?? [options.cwd],
        model: options.model ?? null,
        approvalPolicy: options.codex?.approvalPolicy ?? resolveCodexPermissions(options.permissionMode).approvalPolicy,
        sandbox: options.codex?.sandbox ?? resolveCodexPermissions(options.permissionMode).sandbox,
        developerInstructions: codexDeveloperInstructions(options),
        config: threadConfig,
        dynamicTools: codexDynamicToolDefinitions(options.codex?.dynamicTools),
      });
    }
    this.codexThreadId = result.thread.id;
    this.activeModel = result.model ?? this.activeModel;
    this.discoverModels();
    this.discoverSkills();
  }

  private async registerSkillRoots(): Promise<void> {
    const skillRoots = this.options?.codex?.skillRoots ?? [];
    if (skillRoots.length > 0) {
      try {
        await this.request('skills/extraRoots/set', { extraRoots: skillRoots });
      } catch (error) {
        // Registration is additive. Older app-servers can continue with their
        // normally discovered skills when this runtime API is unavailable.
        console.warn('[ClaudeThreads] Could not register Codex skill roots:', error);
      }
    }
  }

  async setModel(model: string | undefined): Promise<void> {
    if (!this.codexThreadId) return;
    await this.request('thread/settings/update', { threadId: this.codexThreadId, model: model ?? null });
    this.activeModel = model ?? '';
  }

  async setPermissionMode(mode: any): Promise<void> {
    if (!this.codexThreadId) {
      if (this.options) this.options.permissionMode = mode;
      return;
    }
    const permissions = resolveCodexPermissions(mode);
    await this.request('thread/settings/update', {
      threadId: this.codexThreadId,
      collaborationMode: this.collaborationMode(mode === 'plan' ? 'plan' : 'default'),
      approvalPolicy: permissions.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy(permissions.sandbox),
    });
    if (this.options) this.options.permissionMode = mode;
  }

  send(text: string, images?: ImageAttachment[]): void {
    if (this.closed || !this.codexThreadId) throw new Error('Codex session is not running');
    if (this._turnInFlight || this.awaitingPlanApproval) {
      this.queuedTurns.push({ text, images });
      return;
    }
    const effectiveText = applyCodexResumeFallback(text, this.options?.resumeFallbackHistory, this.resumeFallbackPending);
    this.resumeFallbackPending = false;
    this.startTurn(effectiveText, images);
  }

  private startTurn(text: string, images?: ImageAttachment[]): void {
    this._turnInFlight = true;
    this.activeTurnId = undefined;
    this.activeTurnMode = this.options?.permissionMode;
    this.planTransitionRequested = false;
    this.pendingPlanText = null;
    const isPlanMode = this.options?.permissionMode === 'plan';
    if (isPlanMode) this.options?.callbacks.onEnterPlanMode?.();
    const input: any[] = [{ type: 'text', text, text_elements: [] }];
    for (const image of images ?? []) input.push({ type: 'image', url: `data:${image.mediaType};base64,${image.base64}` });
    this.turnStartPromise = this.request('turn/start', {
      threadId: this.codexThreadId,
      input,
      ...(isPlanMode ? {
        collaborationMode: this.collaborationMode('plan'),
      } : {}),
    }).then((result) => {
      this.activeTurnId = result.turn?.id;
      return this.activeTurnId;
    })
      .catch((error) => {
        this.clearTerminalState();
        this.options?.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        return undefined;
      });
  }

  private clearTerminalState(retainApproval = false): void {
    this._turnInFlight = false;
    this.activeTurnId = undefined;
    this.activeTurnMode = undefined;
    this.turnStartPromise = null;
    this.pendingPlanText = null;
    this.planTransitionRequested = false;
    this.queuedTurns = [];
    this.approvalTransitionInFlight = false;
    if (!retainApproval) this.awaitingPlanApproval = false;
  }

  private collaborationMode(mode: 'default' | 'plan'): Record<string, unknown> {
    return {
      mode,
      settings: { model: this.activeModel, reasoning_effort: null, developer_instructions: null },
    };
  }

  private async startRequestedPlanContinuation(callbacks: SessionCallbacks): Promise<void> {
    try {
      await this.setPermissionMode('plan');
      await callbacks.onPlanModeRequested?.();
      if (this.closed || !this._turnInFlight) return;
      this.startTurn(
        'Continue in read-only Plan mode. Investigate the request thoroughly, identify affected files and risks, and produce a complete implementation and verification plan for approval. Do not implement yet.',
      );
    } catch (error) {
      this.clearTerminalState();
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async interrupt(): Promise<void> {
    if (!this.codexThreadId || !this._turnInFlight) return;
    this.queuedTurns = [];
    this.planTransitionRequested = false;
    this.awaitingPlanApproval = false;
    const turnId = this.activeTurnId ?? await this.turnStartPromise;
    if (!turnId || !this._turnInFlight) {
      this._turnInFlight = false;
      return;
    }
    await this.request('turn/interrupt', { threadId: this.codexThreadId, turnId });
  }

  close(): void {
    this.closed = true;
    this._turnInFlight = false;
    this.activeTurnId = undefined;
    this.activeTurnMode = undefined;
    this.turnStartPromise = null;
    this.queuedTurns = [];
    this.activeSubagentTurns.clear();
    this.process?.kill();
    this.process = null;
    this.failAll(new Error('Codex session closed'));
  }

  async getContextUsage(): Promise<ContextUsage | null> { return this.latestContextUsage; }

  async getUsageSnapshot(includeAccountUsage = false): Promise<UsageSnapshot | null> {
    if (!includeAccountUsage) return this.latestUsage;
    try {
      const accountUsage = normalizeCodexAccountUsage(await this.request('account/usage/read', {}));
      const update: UsageSnapshot = {
        provider: 'codex', updatedAt: Date.now(), quotaWindows: [], accountUsage, accountUsageUnavailable: undefined,
      };
      this.latestUsage = mergeUsageSnapshot(this.latestUsage, update);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.latestUsage = mergeUsageSnapshot(this.latestUsage, {
        provider: 'codex', updatedAt: Date.now(), quotaWindows: [],
        accountUsage: undefined, accountUsageUnavailable: message,
      });
    }
    return this.latestUsage;
  }

  private async loadInitialRateLimits(): Promise<void> {
    try {
      const result = await this.request('account/rateLimits/read', {});
      this.applyRateLimits(result);
    } catch (error) {
      console.warn('[ClaudeThreads] Could not read Codex rate limits:', error);
    }
  }

  private applyUsage(update: UsageSnapshot): void {
    this.latestUsage = mergeUsageSnapshot(this.latestUsage, update);
    this.options?.callbacks.onUsage?.(this.latestUsage);
  }

  private applyRateLimits(rateLimits: Record<string, unknown>): void {
    this.applyUsage(normalizeCodexRateLimitResponse(rateLimits));
  }

  private discoverModels(): void {
    this.request('model/list', { limit: 100 })
      .then((result: { data?: Array<{ id?: string; displayName?: string; model?: string }> }) => {
        const models = (result.data ?? [])
          .map((model) => ({ value: model.id ?? model.model ?? '', displayName: model.displayName ?? model.id ?? model.model ?? '' }))
          .filter((model) => model.value && model.displayName);
        if (models.length > 0) this.options?.callbacks.onCapabilitiesDiscovered?.(models as any, []);
      })
      .catch((error) => console.warn('[ClaudeThreads] Could not list Codex models:', error));
  }

  private discoverSkills(): void {
    this.request('skills/list', {
      cwds: this.options?.cwd ? [this.options.cwd] : [],
      forceReload: true,
    })
      .then((result: { data?: Array<{ skills?: Array<{ name?: string; description?: string; shortDescription?: string; enabled?: boolean }> }> }) => {
        const commands = (result.data ?? [])
          .flatMap((entry) => entry.skills ?? [])
          .filter((skill) => skill.enabled !== false && !!skill.name)
          .map((skill) => ({
            name: String(skill.name),
            description: String(skill.description ?? skill.shortDescription ?? ''),
            argumentHint: '',
          }));
        if (commands.length > 0) this.options?.callbacks.onCommandsChanged?.(commands);
      })
      .catch((error) => console.warn('[ClaudeThreads] Could not list Codex skills:', error));
  }

  private sandboxPolicy(sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'): Record<string, unknown> {
    if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
    if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
    return {
      type: 'workspaceWrite',
      writableRoots: this.options?.additionalDirectories ?? (this.options?.cwd ? [this.options.cwd] : []),
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.process?.stdin.writable) return Promise.reject(new Error('Codex app-server is not available'));
    const id = this.nextId++;
    this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private respond(id: string | number, result: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify(params ? { method, params } : { method })}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { this.handle(JSON.parse(line)); } catch (error) { console.warn('[ClaudeThreads] Invalid Codex app-server message:', error); }
    }
  }

  private handle(message: any): void {
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? String(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if ((typeof message.id === 'number' || typeof message.id === 'string') && message.method) { this.handleServerRequest(message); return; }
    const callbacks = this.options?.callbacks; if (!callbacks) return;
    const params = message.params ?? {};
    // Match Claude's raw-log behavior: persist complete protocol events but
    // omit high-volume text deltas that are reconstructed by agentMessage.
    if (message.method !== 'item/agentMessage/delta') {
      callbacks.onRawEvent?.({ type: String(message.method ?? 'codex/event'), ...message });
    }
    switch (message.method) {
      case 'item/agentMessage/delta': callbacks.onToken(String(params.delta ?? '')); break;
      case 'item/started': {
        const item = params.item;
        this.reportEditedFiles(item, callbacks);
        if (this.isToolItem(item)) {
          callbacks.onToolUse({ toolUseId: item.id, name: this.toolName(item), summary: this.toolSummary(item), status: 'pending' });
        }
        this.handleCollaborationItem(item, callbacks, false);
        break;
      }
      case 'item/completed': {
        const item = params.item;
        this.reportEditedFiles(item, callbacks);
        if (item?.type === 'agentMessage' && item.text) callbacks.onMessage(item.text, []);
        if (item?.type === 'plan' && item.text) this.pendingPlanText = String(item.text);
        if (item?.type === 'contextCompaction') callbacks.onCompact?.('auto', this.latestContextUsage?.totalTokens ?? 0);
        this.handleCollaborationItem(item, callbacks, true);
        if (item?.id && this.isToolItem(item)) {
          callbacks.onToolResult?.(item.id, this.itemFailed(item) ? 'error' : 'success', item.durationMs ?? undefined);
        }
        break;
      }
      case 'turn/plan/updated': {
        if (params.threadId !== this.codexThreadId || !Array.isArray(params.plan)) break;
        const tasks = params.plan.flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const { step, status } = item as { step?: unknown; status?: unknown };
          if (typeof step !== 'string' || step.trim().length === 0) return [];
          if (status === 'pending' || status === 'completed') return [{ content: step, status }];
          if (status === 'inProgress') return [{ content: step, status: 'in_progress' as const }];
          return [];
        });
        if (params.plan.length > 0 && tasks.length === 0) break;
        callbacks.onTaskEvent?.({ kind: 'replace', tasks });
        break;
      }
      case 'turn/started': {
        const eventThreadId = params.threadId ? String(params.threadId) : undefined;
        if (eventThreadId && eventThreadId !== this.codexThreadId && this.announcedSubagents.has(eventThreadId)) {
          if (params.turn?.id) this.activeSubagentTurns.set(eventThreadId, String(params.turn.id));
          callbacks.onTaskUpdated?.(eventThreadId, { status: 'in_progress' });
        }
        break;
      }
      case 'turn/completed': {
        const eventThreadId = params.threadId ? String(params.threadId) : undefined;
        if (eventThreadId && eventThreadId !== this.codexThreadId) {
          if (this.announcedSubagents.has(eventThreadId)) {
            const childTurn = params.turn ?? {};
            const activeChildTurnId = this.activeSubagentTurns.get(eventThreadId);
            if (activeChildTurnId && childTurn.id && String(childTurn.id) !== activeChildTurnId) break;
            this.activeSubagentTurns.delete(eventThreadId);
            const status = childTurn.status === 'failed' ? 'failed'
              : childTurn.status === 'interrupted' ? 'killed'
              : 'completed';
            callbacks.onTaskUpdated?.(eventThreadId, {
              status,
              error: childTurn.status === 'failed' ? childTurn.error?.message ?? undefined : undefined,
            });
          }
          break;
        }
        const turn = params.turn ?? {};
        if (turn.id && this.activeTurnId && String(turn.id) !== this.activeTurnId) break;
        this._turnInFlight = false;
        this.activeTurnId = undefined;
        this.turnStartPromise = null;
        const completedTurnMode = this.activeTurnMode ?? this.options?.permissionMode;
        const enterPlanRequested = this.planTransitionRequested;
        this.activeTurnMode = undefined;
        this.planTransitionRequested = false;
        if (turn.status === 'interrupted') {
          this.awaitingPlanApproval = false;
          this.queuedTurns = [];
          callbacks.onInterrupted(this.codexThreadId ?? '');
          this.pendingPlanText = null;
          return;
        }
        else if (turn.status === 'failed') {
          this.awaitingPlanApproval = false;
          this.queuedTurns = [];
          callbacks.onError(new Error(turn.error?.message ?? 'Codex turn failed'));
          this.pendingPlanText = null;
          return;
        }
        else {
          const planText = this.pendingPlanText;
          if (enterPlanRequested && completedTurnMode !== 'plan') {
            this.pendingPlanText = null;
            // Keep sends queued across the settings update so the internal Plan
            // continuation always wins the turn boundary.
            this._turnInFlight = true;
            void this.startRequestedPlanContinuation(callbacks);
            break;
          }
          if (planText && completedTurnMode === 'plan' && callbacks.onPlanReady) {
            this.awaitingPlanApproval = true;
            callbacks.onPlanReady(
              planText,
              (editedPlan) => {
                if (!this.awaitingPlanApproval || this.approvalTransitionInFlight) return;
                this.approvalTransitionInFlight = true;
                // Reserve the single active-turn slot before the async settings
                // update so a send racing the approval click queues behind the
                // internal implementation continuation.
                this._turnInFlight = true;
                const implementationPrompt = editedPlan !== undefined && editedPlan !== planText
                  ? `The plan was approved with these edits. Implement it now:\n\n${editedPlan}`
                  : 'The plan is approved. Implement it now.';
                void this.setPermissionMode('default')
                  .then(async () => {
                    await callbacks.onPlanApprovalCommitted?.();
                    this.approvalTransitionInFlight = false;
                    this.awaitingPlanApproval = false;
                    if (!this.closed) this.startTurn(implementationPrompt);
                  })
                  .catch((error) => {
                    const transitionError = error instanceof Error ? error : new Error(String(error));
                    this.clearTerminalState(true);
                    callbacks.onPlanTransitionError?.(transitionError);
                  });
              },
              () => {
                // The shared plan card sends a rejection follow-up. Keeping the
                // cached mode in Plan makes that follow-up a revision turn.
                this.awaitingPlanApproval = false;
                const next = this.queuedTurns.shift();
                if (next && !this.closed) this.startTurn(next.text, next.images);
                return next !== undefined;
              },
            );
          } else if (completedTurnMode === 'plan') {
            this.queuedTurns = [];
            callbacks.onError(new Error('Codex Plan turn completed without a structured plan.'));
            this.pendingPlanText = null;
            return;
          } else {
            callbacks.onDone(this.codexThreadId ?? '', 0, 1);
          }
        }
        this.pendingPlanText = null;
        if (!this.awaitingPlanApproval) {
          const next = this.queuedTurns.shift();
          if (next && !this.closed) this.startTurn(next.text, next.images);
        }
        break;
      }
      case 'thread/tokenUsage/updated':
        this.latestContextUsage = codexContextUsage(params.tokenUsage as CodexThreadTokenUsage, this.activeModel);
        this.applyUsage(normalizeCodexTokenUsage(params.tokenUsage));
        break;
      case 'model/rerouted':
        this.activeModel = String(params.toModel ?? this.activeModel);
        callbacks.onModelFallback?.(String(params.reason ?? 'rerouted'), String(params.fromModel ?? ''), this.activeModel);
        break;
      case 'warning':
      case 'guardianWarning':
      case 'deprecationNotice':
      case 'configWarning':
        callbacks.onNotification?.(String(params.message ?? params.warning ?? 'Codex warning'), 'medium');
        break;
      case 'account/rateLimits/updated': {
        this.applyRateLimits(params);
        const window = params.rateLimits?.primary ?? params.rateLimits?.secondary;
        const used = Number(window?.usedPercent ?? 0);
        const status = used >= 100 || params.rateLimits?.rateLimitReachedType ? 'rejected'
          : used >= 80 ? 'allowed_warning'
          : 'allowed';
        const resetsAt = typeof window?.resetsAt === 'number' ? window.resetsAt * 1000 : undefined;
        callbacks.onRateLimit?.(status, resetsAt);
        break;
      }
      case 'skills/changed':
        this.discoverSkills();
        break;
      case 'thread/compacted': callbacks.onCompact?.('auto', 0); break;
    }
  }

  private handleServerRequest(message: any): void {
    const callbacks = this.options?.callbacks;
    const params = message.params ?? {};
    if (message.method === 'item/tool/call' && params.tool === ENTER_PLAN_MODE_TOOL.name) {
      if ((params.threadId && String(params.threadId) !== this.codexThreadId)
        || (params.turnId && this.activeTurnId && String(params.turnId) !== this.activeTurnId)) {
        this.respond(message.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: 'EnterPlanMode was rejected for a stale or non-root Codex turn.' }],
        });
        return;
      }
      if (!this._turnInFlight) {
        this.respond(message.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: 'EnterPlanMode is only available during an active Codex turn.' }],
        });
        return;
      }
      if (this.activeTurnMode !== 'plan') this.planTransitionRequested = true;
      this.respond(message.id, {
        success: true,
        contentItems: [{
          type: 'inputText',
          text: this.options?.permissionMode === 'plan'
            ? 'Codex is already in Plan mode.'
            : 'Plan mode requested. Finish this handoff without making changes; a read-only planning turn will start next.',
        }],
      });
      return;
    }
    if (message.method === 'mcpServer/elicitation/request') {
      const requestedSchema = (params.requestedSchema ?? {}) as Record<string, unknown>;
      const properties = requestedSchema.properties;
      const isEmptyForm = params.mode !== 'url'
        && (!properties || (typeof properties === 'object' && Object.keys(properties).length === 0));
      if (isEmptyForm && callbacks?.onPermissionRequest) {
        const serverName = String(params.serverName ?? 'server');
        const detail = String(params.message ?? `${serverName} requests permission to continue`);
        callbacks.onPermissionRequest(`MCP: ${serverName}`, detail)
          .then((allow) => this.respond(message.id, {
            action: allow ? 'accept' : 'decline',
            content: allow ? {} : null,
            _meta: null,
          }))
          .catch(() => this.respond(message.id, { action: 'decline', content: null, _meta: null }));
        return;
      }
      if (!callbacks?.onElicitation) {
        this.respond(message.id, { action: 'cancel', content: null, _meta: null });
        return;
      }
      const request = params.mode === 'url'
        ? {
            serverName: String(params.serverName ?? ''),
            message: String(params.message ?? ''),
            mode: 'url' as const,
            url: String(params.url ?? ''),
            elicitationId: String(params.elicitationId ?? ''),
          }
        : {
            serverName: String(params.serverName ?? ''),
            message: String(params.message ?? ''),
            mode: 'form' as const,
            requestedSchema,
          };
      callbacks.onElicitation(request, new AbortController().signal)
        .then((result) => this.respond(message.id, {
          action: result.action,
          content: result.action === 'accept' ? (result.content ?? {}) : null,
          _meta: null,
        }))
        .catch(() => this.respond(message.id, { action: 'cancel', content: null, _meta: null }));
      return;
    }
    if (message.method === 'item/tool/call') {
      const dynamicTool = this.options?.codex?.dynamicTools?.find((tool) => tool.name === params.tool);
      if (!dynamicTool) {
        this.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: `Unknown built-in Claude Threads tool: ${params.tool}` }] });
        return;
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const approval = resolveDynamicToolApproval(this.options?.permissionMode ?? 'default', dynamicTool.requiresApproval);
      if (approval === 'deny') {
        this.respond(message.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: `${dynamicTool.name} is unavailable in the current permission mode.` }],
        });
        return;
      }
      const invoke = () => dynamicTool.invoke(args)
        .then((result) => this.respond(message.id, {
          success: result.success,
          contentItems: [{ type: 'inputText', text: result.text }],
        }))
        .catch((error) => this.respond(message.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }],
        }));
      if (approval === 'prompt') {
        const detail = `${dynamicTool.description}\n\nArguments:\n${JSON.stringify(args, null, 2)}`;
        if (!callbacks) {
          this.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: `Permission denied for ${dynamicTool.name}.` }] });
          return;
        }
        callbacks.onPermissionRequest(`Claude Threads: ${dynamicTool.name}`, detail)
          .then((allow) => {
            if (allow) invoke();
            else this.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: `Permission denied for ${dynamicTool.name}.` }] });
          })
          .catch(() => this.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: `Permission denied for ${dynamicTool.name}.` }] }));
      } else {
        invoke();
      }
      return;
    }
    const isApproval = /requestApproval$/.test(message.method);
    if (!callbacks || !isApproval) { this.respond(message.id, {}); return; }
    const detail = String(params.command ?? params.reason ?? 'Codex requests permission to continue');
    callbacks.onPermissionRequest('Codex', detail).then((allow) => {
      const decision = allow ? 'accept' : 'decline';
      this.respond(message.id, message.method.includes('fileChange') ? { decision } : { decision });
    }).catch(() => this.respond(message.id, { decision: 'decline' }));
  }

  private toolSummary(item: any): string {
    return String(item.command ?? item.path ?? item.prompt ?? item.tool ?? item.server ?? item.query ?? item.type);
  }

  private toolName(item: any): string {
    if (item.type === 'collabAgentToolCall') return 'Agent';
    if (item.type === 'dynamicToolCall') return String(item.tool ?? 'dynamicToolCall');
    if (item.type === 'mcpToolCall') return `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`;
    return String(item.type);
  }

  private reportEditedFiles(item: any, callbacks: SessionCallbacks): void {
    if (item?.type !== 'fileChange' || !Array.isArray(item.changes)) return;
    const paths = item.changes
      .map((change: any) => change?.path)
      .filter((filePath: unknown): filePath is string => typeof filePath === 'string' && filePath.length > 0);
    if (paths.length > 0) callbacks.onFilesEdited?.(paths);
  }

  private isToolItem(item: any): boolean {
    return ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration', 'imageView'].includes(item?.type);
  }

  private itemFailed(item: any): boolean {
    return item?.status === 'failed' || item?.status === 'errored' || item?.success === false || !!item?.error;
  }

  private handleCollaborationItem(item: any, callbacks: SessionCallbacks, completed: boolean): void {
    if (!item) return;
    if (item.type === 'collabAgentToolCall') {
      const ids: string[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String) : [];
      if (item.tool === 'spawnAgent') {
        for (const id of ids) {
          if (!this.announcedSubagents.has(id)) {
            this.announcedSubagents.add(id);
            callbacks.onTaskStarted?.(id, String(item.prompt ?? 'Codex sub-agent'), false, 'subagent', undefined, undefined, item.senderThreadId ? String(item.senderThreadId) : undefined, item.model ?? undefined);
          }
          if (completed) {
            const state = item.agentsStates?.[id];
            const status = state?.status === 'errored' ? 'failed'
              : state?.status === 'interrupted' || state?.status === 'shutdown' ? 'killed'
              : state?.status === 'completed' ? 'completed'
              : undefined;
            if (status) callbacks.onTaskUpdated?.(id, { status, error: state?.status === 'errored' ? state?.message ?? undefined : undefined });
          }
        }
      } else if (completed) {
        for (const id of ids) callbacks.onTaskProgress?.(id, item.prompt ? String(item.prompt) : `Agent ${item.tool}`, item.tool);
      }
      return;
    }
    if (item.type === 'subAgentActivity') {
      // The root/coordinator agent (agentPath '/root') is the main session
      // thread itself, not a spawned child. When a Codex thread is resumed, the
      // prior session's root reappears in the new session's stream as a
      // subAgentActivity item; announcing it as a sub-agent creates an AgentRun
      // that never settles — it only ever emits kind 'interacted' (never
      // 'interrupted'), and being a root it never receives a child-scoped
      // turn/completed under the announcedSubagents guard — so the thread stays
      // wedged on "Working" forever. Skip the root; genuine children have nested
      // paths ('/root/<name>'). A missing agentPath falls through unchanged.
      if (item.agentPath === '/root') return;
      const id = String(item.agentThreadId ?? item.id);
      if (!this.announcedSubagents.has(id)) {
        this.announcedSubagents.add(id);
        callbacks.onTaskStarted?.(id, `Codex sub-agent ${id}`, false, 'subagent', undefined, undefined, item.parentThreadId ? String(item.parentThreadId) : undefined, item.model ? String(item.model) : undefined);
      }
      if (item.kind === 'interrupted') callbacks.onTaskUpdated?.(id, { status: 'killed' });
      else callbacks.onTaskProgress?.(id, `Sub-agent ${item.kind}`, item.kind);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

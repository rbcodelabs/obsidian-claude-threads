import { describe, expect, it, vi } from 'vitest';
import { CodexSession, codexContextUsage, codexMcpServers } from '../../src/CodexSession';

describe('codexMcpServers', () => {
  it('translates stdio and remote MCP transports to Codex config keys', () => {
    expect(codexMcpServers({
      local: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'secret' }, timeout: 5_000 },
      remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer secret' } },
    })).toEqual({
      local: { command: 'node', args: ['server.js'], env: { TOKEN: 'secret' }, tool_timeout_sec: 5 },
      remote: { url: 'https://mcp.example.test', http_headers: { Authorization: 'Bearer secret' } },
    });
  });

  it('skips in-process SDK servers that cannot cross the app-server boundary', () => {
    expect(codexMcpServers({
      obsidian: { type: 'sdk', name: 'obsidian', instance: {} as any },
    })).toEqual({});
  });
});

describe('codexContextUsage', () => {
  it('maps app-server token usage into the shared context snapshot', () => {
    const result = codexContextUsage({
      total: {
        totalTokens: 24_000,
        inputTokens: 20_000,
        cachedInputTokens: 5_000,
        cacheWriteInputTokens: 0,
        outputTokens: 4_000,
        reasoningOutputTokens: 1_500,
      },
      last: {
        totalTokens: 4_000,
        inputTokens: 3_000,
        cachedInputTokens: 500,
        cacheWriteInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 250,
      },
      modelContextWindow: 120_000,
    }, 'gpt-5.6-codex');

    expect(result).toMatchObject({
      totalTokens: 24_000,
      maxTokens: 120_000,
      percentage: 20,
      model: 'gpt-5.6-codex',
      categories: [
        { name: 'Input', tokens: 15_000 },
        { name: 'Cached input', tokens: 5_000 },
        { name: 'Output', tokens: 2_500 },
        { name: 'Reasoning', tokens: 1_500 },
      ],
    });
  });

  it('returns null until Codex reports a context-window size', () => {
    expect(codexContextUsage({
      total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: null,
    }, '')).toBeNull();
  });
});

describe('CodexSession protocol notifications', () => {
  it('reports every path from a multi-file fileChange through the shared edited-files callback', () => {
    const managerEditedFiles: string[] = [];
    const onFilesEdited = (paths: string[]) => {
      for (const filePath of paths) {
        if (!managerEditedFiles.includes(filePath)) managerEditedFiles.push(filePath);
      }
    };
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = {
      callbacks: {
        onRawEvent: vi.fn(),
        onToolUse: vi.fn(),
        onFilesEdited,
      },
    };

    internal.handle({
      method: 'item/started',
      params: {
        item: {
          type: 'fileChange',
          id: 'change-1',
          status: 'inProgress',
          changes: [
            { path: '/project/src/a.ts', kind: 'update', diff: '@@' },
            { path: '/project/src/b.ts', kind: 'create', diff: '@@' },
            { path: '', kind: 'update', diff: '@@' },
          ],
        },
      },
    });

    expect(managerEditedFiles).toEqual(['/project/src/a.ts', '/project/src/b.ts']);
  });

  it('waits for the active turn id before sending Stop to Codex', async () => {
    let acceptTurn!: (result: { turn: { id: string } }) => void;
    const turnAccepted = new Promise<{ turn: { id: string } }>((resolve) => { acceptTurn = resolve; });
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.options = { callbacks: { onError: vi.fn() } };
    const request = vi.spyOn(internal, 'request').mockImplementation((method: string) => (
      method === 'turn/start' ? turnAccepted : Promise.resolve({})
    ));

    session.send('Keep working');
    const stopped = session.interrupt();

    expect(request).toHaveBeenCalledOnce();
    acceptTurn({ turn: { id: 'turn-1' } });
    await stopped;

    expect(request).toHaveBeenLastCalledWith('turn/interrupt', {
      threadId: 'codex-thread',
      turnId: 'turn-1',
    });
  });

  it('caches usage, raw-logs the notification, and reports a completed turn', async () => {
    const onDone = vi.fn();
    const onRawEvent = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'codex-thread';
    internal.activeModel = 'gpt-5.6-codex';
    internal.options = {
      callbacks: { onDone, onRawEvent },
    };

    internal.handle({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'codex-thread',
        turnId: 'turn-1',
        tokenUsage: {
          total: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
          last: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
          modelContextWindow: 100,
        },
      },
    });
    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });

    await expect(session.getContextUsage()).resolves.toMatchObject({ totalTokens: 10, maxTokens: 100 });
    expect(onRawEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'thread/tokenUsage/updated' }));
    expect(onDone).toHaveBeenCalledWith('codex-thread', 0, 1);
  });

  it('does not raw-log streaming text deltas', () => {
    const onRawEvent = vi.fn();
    const onToken = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onRawEvent, onToken } };

    (session as any).handle({ method: 'item/agentMessage/delta', params: { delta: 'hello' } });

    expect(onToken).toHaveBeenCalledWith('hello');
    expect(onRawEvent).not.toHaveBeenCalled();
  });

  it('accepts string IDs on app-server requests', () => {
    const session = new CodexSession('codex');
    const respond = vi.spyOn(session as any, 'respond');
    (session as any).options = { callbacks: {} };

    (session as any).handle({ id: 'server-request-1', method: 'unknown/request', params: {} });

    expect(respond).toHaveBeenCalledWith('server-request-1', {});
  });

  it('recognizes context-compaction items from the current protocol', () => {
    const onCompact = vi.fn();
    const onToolResult = vi.fn();
    const session = new CodexSession('codex');
    (session as any).latestContextUsage = { totalTokens: 42_000 };
    (session as any).options = { callbacks: { onCompact, onToolResult } };

    (session as any).handle({
      method: 'item/completed',
      params: { item: { type: 'contextCompaction', id: 'compact-1' } },
    });

    expect(onCompact).toHaveBeenCalledWith('auto', 42_000);
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it('routes MCP form elicitations through the shared inline UI callback', async () => {
    const onElicitation = vi.fn().mockResolvedValue({ action: 'accept', content: { project: 'parity' } });
    const session = new CodexSession('codex');
    const respond = vi.spyOn(session as any, 'respond');
    (session as any).options = { callbacks: { onElicitation } };

    (session as any).handle({
      id: 'elicit-1',
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        serverName: 'linear',
        message: 'Choose a project',
        requestedSchema: { type: 'object', properties: { project: { type: 'string' } } },
      },
    });
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());

    expect(onElicitation).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'linear',
      mode: 'form',
      message: 'Choose a project',
    }), expect.any(AbortSignal));
    expect(respond).toHaveBeenCalledWith('elicit-1', {
      action: 'accept',
      content: { project: 'parity' },
      _meta: null,
    });
  });

  it('routes empty-schema MCP elicitations through the shared permission callback', async () => {
    const onPermissionRequest = vi.fn().mockResolvedValue(true);
    const onElicitation = vi.fn();
    const session = new CodexSession('codex');
    const respond = vi.spyOn(session as any, 'respond');
    (session as any).options = { callbacks: { onPermissionRequest, onElicitation } };

    (session as any).handle({
      id: 'elicit-permission-1',
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        serverName: 'github',
        message: 'Allow the GitHub MCP server to run search_repositories?',
        requestedSchema: { type: 'object', properties: {} },
      },
    });
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());

    expect(onPermissionRequest).toHaveBeenCalledWith(
      'MCP: github',
      'Allow the GitHub MCP server to run search_repositories?',
    );
    expect(onElicitation).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('elicit-permission-1', {
      action: 'accept',
      content: {},
      _meta: null,
    });
  });

  it('surfaces a completed Codex plan and starts implementation after approval', async () => {
    const onDone = vi.fn();
    const onPlanReady = vi.fn();
    const onEnterPlanMode = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.activeModel = 'gpt-5.6-codex';
    internal.options = {
      permissionMode: 'plan',
      callbacks: { onDone, onPlanReady, onEnterPlanMode, onError: vi.fn() },
    };
    vi.spyOn(internal, 'request').mockResolvedValue({});
    const send = vi.spyOn(session, 'send').mockImplementation(() => {});

    internal.startTurn('Make a plan');
    expect(onEnterPlanMode).toHaveBeenCalledOnce();
    expect(internal.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.6-codex', reasoning_effort: null, developer_instructions: null } },
    }));
    internal.handle({ method: 'item/completed', params: { item: { type: 'plan', id: 'plan-1', text: '1. Ship it' } } });
    internal.handle({ method: 'turn/completed', params: { turn: { status: 'completed' } } });

    expect(onDone).toHaveBeenCalledBefore(onPlanReady);
    expect(onPlanReady).toHaveBeenCalledWith('1. Ship it', expect.any(Function), expect.any(Function));
    const approve = onPlanReady.mock.calls[0][1];
    approve('1. Ship it\n2. Verify it');
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(internal.options.permissionMode).toBe('default');
    expect(send).toHaveBeenCalledWith('The plan was approved with these edits. Implement it now:\n\n1. Ship it\n2. Verify it');
  });

  it('maps Codex collaboration items to shared sub-agent task events', () => {
    const onTaskStarted = vi.fn();
    const onTaskUpdated = vi.fn();
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onTaskStarted, onTaskUpdated, onToolUse, onToolResult } };
    const started = {
      type: 'collabAgentToolCall', id: 'call-1', tool: 'spawnAgent', status: 'inProgress',
      receiverThreadIds: ['agent-1'], prompt: 'Audit event coverage', model: 'gpt-5.6-codex', agentsStates: {},
    };
    (session as any).handle({ method: 'item/started', params: { item: started } });
    (session as any).handle({
      method: 'item/completed',
      params: { item: { ...started, status: 'completed', agentsStates: { 'agent-1': { status: 'completed', message: 'Done' } } } },
    });

    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({ name: 'Agent', summary: 'Audit event coverage' }));
    expect(onTaskStarted).toHaveBeenCalledWith('agent-1', 'Audit event coverage', false, 'subagent', undefined, undefined, undefined, 'gpt-5.6-codex');
    expect(onTaskUpdated).toHaveBeenCalledWith('agent-1', { status: 'completed', error: undefined });
    expect(onToolResult).toHaveBeenCalledWith('call-1', 'success', undefined);
  });

  it('marks a Codex sub-agent completed from its child-scoped turn completion', () => {
    const onTaskStarted = vi.fn();
    const onTaskUpdated = vi.fn();
    const onDone = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'parent-thread';
    internal._turnInFlight = true;
    internal.options = { callbacks: { onTaskStarted, onTaskUpdated, onDone, onTaskProgress: vi.fn() } };
    const started = {
      type: 'subAgentActivity', id: 'activity-1', kind: 'started',
      agentThreadId: 'agent-1', agentPath: '/root/engineer',
    };

    internal.handle({ method: 'item/completed', params: { item: started } });
    internal.handle({
      method: 'turn/completed',
      params: { threadId: 'agent-1', turn: { id: 'child-turn', status: 'completed', error: null } },
    });

    expect(onTaskStarted).toHaveBeenCalledTimes(1);
    expect(onTaskUpdated).toHaveBeenCalledWith('agent-1', { status: 'completed' });
    expect(onDone).not.toHaveBeenCalled();
    expect(internal._turnInFlight).toBe(true);
  });

  it('tracks child follow-up turns without accepting a late terminal event', () => {
    const onTaskStarted = vi.fn();
    const onTaskUpdated = vi.fn();
    const onDone = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'parent-thread';
    internal.options = { callbacks: { onTaskStarted, onTaskUpdated, onDone, onTaskProgress: vi.fn() } };
    internal.handle({ method: 'item/completed', params: { item: {
      type: 'subAgentActivity', id: 'activity-1', kind: 'started',
      agentThreadId: 'nested-agent', agentPath: '/root/engineer/reviewer',
    } } });
    internal.handle({ method: 'turn/started', params: {
      threadId: 'nested-agent', turn: { id: 'child-turn-2', status: 'inProgress' },
    } });
    expect(onTaskUpdated).toHaveBeenLastCalledWith('nested-agent', { status: 'in_progress' });
    onTaskUpdated.mockClear();

    internal.handle({ method: 'turn/completed', params: {
      threadId: 'nested-agent', turn: { id: 'child-turn-1', status: 'completed', error: null },
    } });
    expect(onTaskUpdated).not.toHaveBeenCalled();

    internal.handle({ method: 'turn/completed', params: {
      threadId: 'nested-agent', turn: { id: 'child-turn-2', status: 'failed', error: { message: 'Review failed' } },
    } });
    expect(onTaskUpdated).toHaveBeenCalledWith('nested-agent', { status: 'failed', error: 'Review failed' });
    expect(onDone).not.toHaveBeenCalled();

    onTaskUpdated.mockClear();
    internal.handle({ method: 'turn/completed', params: {
      threadId: 'unannounced-agent', turn: { id: 'unknown-turn', status: 'interrupted', error: null },
    } });
    expect(onTaskUpdated).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    internal.handle({ method: 'item/completed', params: { item: {
      type: 'subAgentActivity', id: 'activity-2', kind: 'started',
      agentThreadId: 'stopped-agent', agentPath: '/root/stopped',
    } } });
    internal.handle({ method: 'turn/completed', params: {
      threadId: 'stopped-agent', turn: { id: 'stopped-turn', status: 'interrupted', error: null },
    } });
    expect(onTaskUpdated).toHaveBeenCalledWith('stopped-agent', { status: 'killed', error: undefined });
  });

  it('does not emit phantom tool results for reasoning items', () => {
    const onToolResult = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onToolResult } };
    (session as any).handle({ method: 'item/completed', params: { item: { type: 'reasoning', id: 'reason-1' } } });
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it('maps reroutes, warnings, and rate limits to shared status events', () => {
    const onModelFallback = vi.fn();
    const onNotification = vi.fn();
    const onRateLimit = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onModelFallback, onNotification, onRateLimit } };

    (session as any).handle({ method: 'model/rerouted', params: { reason: 'highRiskCyberActivity', fromModel: 'a', toModel: 'b' } });
    (session as any).handle({ method: 'warning', params: { message: 'Context is nearly full' } });
    (session as any).handle({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 85, resetsAt: 2_000 } } } });

    expect(onModelFallback).toHaveBeenCalledWith('highRiskCyberActivity', 'a', 'b');
    expect(onNotification).toHaveBeenCalledWith('Context is nearly full', 'medium');
    expect(onRateLimit).toHaveBeenCalledWith('allowed_warning', 2_000_000);
  });

  it('keeps multiple quota buckets alongside thread tokens', async () => {
    const onUsage = vi.fn();
    const session = new CodexSession('codex');
    (session as any).options = { callbacks: { onUsage } };
    (session as any).handle({ method: 'thread/tokenUsage/updated', params: { tokenUsage: {
      total: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 100, outputTokens: 100, reasoningOutputTokens: 20 },
      last: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 2 },
      modelContextWindow: 1000,
    } } });
    (session as any).handle({ method: 'account/rateLimits/updated', params: { rateLimits: {
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2000 },
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 3000 },
    } } });

    await expect(session.getUsageSnapshot()).resolves.toMatchObject({
      tokens: { total: 500 }, lastTurnTokens: { total: 50 },
      quotaWindows: [{ usedPercent: 20 }, { usedPercent: 60 }],
    });
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it('reads initial rate limits and account activity on demand', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = { callbacks: { onUsage: vi.fn() } };
    const request = vi.spyOn(internal, 'request')
      .mockResolvedValueOnce({
        rateLimits: { primary: { usedPercent: 10, resetsAt: 2000 } },
        rateLimitsByLimitId: { codex: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 3000 } } },
        rateLimitResetCredits: { balance: 2 },
      })
      .mockResolvedValueOnce({ summary: { lifetimeTokens: 123, peakDailyTokens: 50, currentStreakDays: 2 }, dailyUsageBuckets: [{ startDate: '2026-08-17', tokens: 123 }] });

    await internal.loadInitialRateLimits();
    const usage = await session.getUsageSnapshot(true);

    expect(request).toHaveBeenNthCalledWith(1, 'account/rateLimits/read', {});
    expect(request).toHaveBeenNthCalledWith(2, 'account/usage/read', {});
    expect(usage).toMatchObject({
      quotaWindows: [{ label: 'Codex · 5 hours' }, { label: 'Codex · 7 days' }],
      resetCredits: { balance: 2 }, accountUsage: { lifetimeTokens: 123, daily: [{ tokens: 123 }] },
    });
  });

  it('returns quota data with an explicit account-usage error when unauthenticated', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.latestUsage = { provider: 'codex', updatedAt: 1, quotaWindows: [{ label: 'Primary', usedPercent: 10 }] };
    vi.spyOn(internal, 'request').mockRejectedValue(new Error('not authenticated'));

    await expect(session.getUsageSnapshot(true)).resolves.toMatchObject({
      quotaWindows: [{ usedPercent: 10 }], accountUsageUnavailable: 'not authenticated',
    });
  });

  it('discovers enabled Codex skills as shared slash commands', async () => {
    const onCommandsChanged = vi.fn();
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = { cwd: '/project', callbacks: { onCommandsChanged } };
    vi.spyOn(internal, 'request').mockResolvedValue({
      data: [{ skills: [
        { name: 'review', description: 'Review changes', enabled: true },
        { name: 'disabled', description: 'Hidden', enabled: false },
      ] }],
    });

    internal.discoverSkills();
    await vi.waitFor(() => expect(onCommandsChanged).toHaveBeenCalled());
    expect(internal.request).toHaveBeenCalledWith('skills/list', { cwds: ['/project'], forceReload: true });
    expect(onCommandsChanged).toHaveBeenCalledWith([
      { name: 'review', description: 'Review changes', argumentHint: '' },
    ]);
  });

  it('registers configured skill roots with the app-server', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.options = { codex: { skillRoots: ['/skills/source', '/skills/bundled'] } };
    vi.spyOn(internal, 'request').mockResolvedValue({});

    await internal.registerSkillRoots();

    expect(internal.request).toHaveBeenCalledWith('skills/extraRoots/set', {
      extraRoots: ['/skills/source', '/skills/bundled'],
    });
  });
});

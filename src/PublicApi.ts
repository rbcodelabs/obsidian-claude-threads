import type { ChatMessage, Thread, ThreadStatus } from './types';
import type { ThreadEvent } from './ThreadManager';

export type PublicErrorCode = 'PLUGIN_UNAVAILABLE' | 'THREAD_NOT_FOUND' | 'RUN_NOT_FOUND' | 'RUN_FAILED' | 'RUN_INTERRUPTED' | 'ORCHESTRATOR_NOT_FOUND' | 'INVALID_ARGUMENT';
export interface PublicError { readonly code: PublicErrorCode; readonly message: string }
export class ClaudeThreadsApiError extends Error implements PublicError {
  constructor(public readonly code: PublicErrorCode, message: string, public readonly generation?: string) { super(message); this.name = 'ClaudeThreadsApiError'; }
}
export interface MessageSnapshot { readonly id: string; readonly role: ChatMessage['role']; readonly content: string; readonly timestamp: number }
export interface ThreadSummary { readonly id: string; readonly title: string; readonly status: ThreadStatus; readonly reviewed: boolean; readonly cwd?: string; readonly projectId?: string; readonly agentHarness: 'claude' | 'codex'; readonly createdAt: number; readonly updatedAt: number; readonly isRunning: boolean; readonly messageCount: number }
export interface ThreadSnapshot extends ThreadSummary { readonly messages: readonly MessageSnapshot[] }
export interface ThreadQuery { readonly projectId?: string | null; readonly status?: ThreadStatus; readonly limit?: number }
export interface CreateThreadInput { readonly title?: string; readonly cwd?: string; readonly projectId?: string; readonly agentHarness?: 'claude' | 'codex' }
export interface SendInput { readonly prompt: string }
export interface WaitOptions { readonly timeoutMs?: number }
export type RunResult =
  | { readonly status: 'completed'; readonly runId: string; readonly threadId: string; readonly finalMessage?: MessageSnapshot }
  | { readonly status: 'failed'; readonly runId: string; readonly threadId: string; readonly error: PublicError }
  | { readonly status: 'timed_out'; readonly runId: string; readonly threadId: string };
export type PublicThreadEvent =
  | { readonly kind: 'run.started'; readonly threadId: string; readonly runId: string; readonly at: number }
  | { readonly kind: 'message.completed'; readonly threadId: string; readonly runId?: string; readonly message: MessageSnapshot; readonly at: number }
  | { readonly kind: 'run.completed'; readonly threadId: string; readonly runId: string; readonly finalMessage?: MessageSnapshot; readonly at: number }
  | { readonly kind: 'run.failed'; readonly threadId: string; readonly runId: string; readonly error: PublicError; readonly at: number }
  | { readonly kind: 'thread.removed'; readonly threadId: string; readonly at: number };
export interface Disposable { dispose(): void }
export interface OrchestratorSnapshot { readonly id: string; readonly kind: 'portfolio' | 'project'; readonly threadId: string; readonly title: string; readonly projectId?: string }
export interface OrchestratorTarget { readonly id: string }
export interface AgentToolDefinition { readonly type: 'function'; readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> }
export interface AgentToolBundle { readonly tools: readonly AgentToolDefinition[]; execute(name: string, args: Record<string, unknown>): Promise<string> }
export interface ClaudeThreadsApiV1 {
  readonly apiVersion: 1; readonly generation: string; readonly capabilities: readonly string[];
  readonly threads: {
    list(query?: ThreadQuery): Promise<readonly ThreadSummary[]>; get(threadId: string): Promise<ThreadSnapshot | null>;
    create(input: CreateThreadInput): Promise<{ readonly threadId: string }>; send(threadId: string, input: SendInput): Promise<{ readonly runId: string }>;
    wait(runId: string, options?: WaitOptions): Promise<RunResult>; open(threadId: string): Promise<void>; subscribe(listener: (event: PublicThreadEvent) => void): Disposable;
  };
  readonly orchestrators: { list(): Promise<readonly OrchestratorSnapshot[]>; dispatch(target: OrchestratorTarget, input: SendInput): Promise<{ readonly runId: string }> };
  readonly agentTools: { createBundle(profile: 'voice-orchestration'): AgentToolBundle };
}
export interface PublicApiDependencies {
  getThreads(): Thread[]; getThread(id: string): Thread | undefined; isRunning(id: string): boolean; createThread(input: CreateThreadInput): Thread | Promise<Thread>;
  sendMessage(id: string, prompt: string): Promise<void>; openThread(id: string): Promise<void>; subscribe(listener: (threadId: string, event: ThreadEvent) => void): () => void;
  listOrchestrators(): OrchestratorSnapshot[]; resolveOrchestrator(target: OrchestratorTarget): Promise<string | null>;
  triggerHostEvent(name: 'claude-threads:api-ready' | 'claude-threads:api-stopping', payload: { apiVersion: 1; generation: string }): void;
}
interface RunRecord { readonly runId: string; readonly threadId: string; result?: Exclude<RunResult, { status: 'timed_out' }>; waiters: Set<(result: Exclude<RunResult, { status: 'timed_out' }>) => void> }
export interface ClaudeThreadsApiService { readonly api: ClaudeThreadsApiV1; start(): void; stop(): void }

const CAPABILITIES = Object.freeze(['threads.list', 'threads.get', 'threads.create', 'threads.send', 'threads.wait', 'threads.open', 'threads.subscribe', 'orchestrators.list', 'orchestrators.dispatch', 'agentTools.voice-orchestration']);
function freeze<T extends object>(value: T): Readonly<T> { for (const nested of Object.values(value)) if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) freeze(nested as object); return Object.freeze(value); }
function snapshotMessage(message: ChatMessage): MessageSnapshot { return freeze({ id: message.id, role: message.role, content: String(message.content), timestamp: message.timestamp }); }
function snapshotSummary(thread: Thread, running: boolean): ThreadSummary { return freeze({ id: thread.id, title: thread.title, status: thread.status ?? 'waiting', reviewed: thread.reviewed ?? false, cwd: thread.cwd, projectId: thread.projectId, agentHarness: thread.agentHarness ?? 'claude', createdAt: thread.createdAt, updatedAt: thread.updatedAt, isRunning: running, messageCount: thread.messages.length }); }
function snapshotThread(thread: Thread, running: boolean): ThreadSnapshot { return freeze({ ...snapshotSummary(thread, running), messages: thread.messages.map(snapshotMessage) }); }
function stringProp(): Record<string, unknown> { return { type: 'string' }; }
function boolProp(): Record<string, unknown> { return { type: 'boolean' }; }
function numberProp(): Record<string, unknown> { return { type: 'number' }; }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): AgentToolDefinition { return { type: 'function', name, description, parameters: { type: 'object', properties, required } }; }
const VOICE_TOOLS: readonly AgentToolDefinition[] = freeze([
  tool('ct_send_message', 'Send a message to an existing Claude thread.', { message: stringProp(), thread_id: stringProp(), wait: boolProp(), timeout_secs: numberProp() }, ['message', 'thread_id']),
  tool('ct_new_thread', 'Start a new Claude thread with an initial message.', { message: stringProp(), title_hint: stringProp(), wait: boolProp(), timeout_secs: numberProp() }, ['message']),
  tool('ct_wait_for_thread', 'Wait for a Claude thread run to finish.', { thread_id: stringProp(), timeout_secs: numberProp() }),
  tool('ct_get_thread', 'Read messages and status from a Claude thread.', { thread_id: stringProp(), last_n: numberProp() }),
  tool('ct_list_threads', 'List Claude threads and their statuses.', { status: { type: 'string', enum: ['active', 'waiting', 'waiting_new', 'error', 'all'] }, limit: numberProp() }),
  tool('ct_open_thread', 'Open a Claude thread in the host UI.', { thread_id: stringProp() }, ['thread_id']),
]);

export function createClaudeThreadsApiV1(deps: PublicApiDependencies): ClaudeThreadsApiService {
  const generation = crypto.randomUUID();
  const listeners = new Set<(event: PublicThreadEvent) => void>(); const runs = new Map<string, RunRecord>();
  const runIdsByThread = new Map<string, Set<string>>(); const latestRunByThread = new Map<string, string>();
  let active = true; let started = false; let stopped = false;
  const unavailable = () => new ClaudeThreadsApiError('PLUGIN_UNAVAILABLE', 'Agent Threads is not available.', generation);
  const guard = () => { if (!active) throw unavailable(); };
  const publish = (event: PublicThreadEvent) => { if (!active) return; const immutable = freeze(event); for (const listener of [...listeners]) { try { listener(immutable); } catch (error) { console.error('[ClaudeThreads] Public API listener failed:', error); } } };
  const publicFailure = (code: PublicErrorCode): PublicError => freeze({ code, message: code === 'PLUGIN_UNAVAILABLE' ? 'Agent Threads became unavailable.' : code === 'RUN_INTERRUPTED' ? 'The agent run was interrupted.' : 'The agent run failed.' });
  const settle = (record: RunRecord, result: Exclude<RunResult, { status: 'timed_out' }>) => { if (record.result) return; record.result = freeze(result); for (const resolve of [...record.waiters]) resolve(record.result); record.waiters.clear(); runIdsByThread.get(record.threadId)?.delete(record.runId); };
  const activeRuns = (threadId: string) => [...(runIdsByThread.get(threadId) ?? [])].map(id => runs.get(id)).filter((record): record is RunRecord => !!record && !record.result);
  const lastAssistant = (threadId: string) => { const message = [...(deps.getThread(threadId)?.messages ?? [])].reverse().find(candidate => candidate.role === 'assistant'); return message ? snapshotMessage(message) : undefined; };
  const unsubscribeInternal = deps.subscribe((threadId, event) => {
    if (!active) return;
    if (event.type === 'message' && event.message.role === 'assistant') publish({ kind: 'message.completed', threadId, runId: latestRunByThread.get(threadId), message: snapshotMessage(event.message), at: Date.now() });
    else if (event.type === 'done') { const finalMessage = lastAssistant(threadId); for (const record of activeRuns(threadId)) { settle(record, { status: 'completed', runId: record.runId, threadId, finalMessage }); publish({ kind: 'run.completed', threadId, runId: record.runId, finalMessage, at: Date.now() }); } }
    else if (event.type === 'error' || event.type === 'interrupted') { const code = event.type === 'interrupted' ? 'RUN_INTERRUPTED' : 'RUN_FAILED'; for (const record of activeRuns(threadId)) { const error = publicFailure(code); settle(record, { status: 'failed', runId: record.runId, threadId, error }); publish({ kind: 'run.failed', threadId, runId: record.runId, error, at: Date.now() }); } }
    else if (event.type === 'thread_deleted') publish({ kind: 'thread.removed', threadId, at: Date.now() });
  });
  const send = async (threadId: string, input: SendInput): Promise<{ readonly runId: string }> => {
    guard(); if (!deps.getThread(threadId)) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', `Thread not found: ${threadId}`);
    const prompt = input.prompt?.trim(); if (!prompt) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', 'prompt is required.');
    const runId = crypto.randomUUID(); const record: RunRecord = { runId, threadId, waiters: new Set() }; runs.set(runId, record);
    const ids = runIdsByThread.get(threadId) ?? new Set<string>(); ids.add(runId); runIdsByThread.set(threadId, ids); latestRunByThread.set(threadId, runId);
    publish({ kind: 'run.started', threadId, runId, at: Date.now() });
    try { await deps.sendMessage(threadId, prompt); } catch { const error = publicFailure('RUN_FAILED'); settle(record, { status: 'failed', runId, threadId, error }); publish({ kind: 'run.failed', threadId, runId, error, at: Date.now() }); }
    return freeze({ runId });
  };
  const wait = async (runId: string, options?: WaitOptions): Promise<RunResult> => {
    guard(); const record = runs.get(runId); if (!record) throw new ClaudeThreadsApiError('RUN_NOT_FOUND', `Run not found: ${runId}`); if (record.result) return record.result;
    const timeoutMs = Math.max(1, Math.min(options?.timeoutMs ?? 120_000, 600_000));
    return new Promise(resolve => { let done = false; const settleWait = (result: Exclude<RunResult, { status: 'timed_out' }>) => { if (done) return; done = true; clearTimeout(timer); record.waiters.delete(settleWait); resolve(result); }; const timer = setTimeout(() => { if (done) return; done = true; record.waiters.delete(settleWait); resolve(freeze({ status: 'timed_out', runId, threadId: record.threadId })); }, timeoutMs); record.waiters.add(settleWait); });
  };
  const list = async (query?: ThreadQuery): Promise<readonly ThreadSummary[]> => { guard(); let values = deps.getThreads(); if (query?.projectId !== undefined) values = values.filter(thread => (thread.projectId ?? null) === query.projectId); if (query?.status) values = values.filter(thread => (thread.status ?? 'waiting') === query.status); if (query?.limit !== undefined) values = values.slice(0, Math.max(0, Math.floor(query.limit))); return freeze(values.map(thread => snapshotSummary(thread, deps.isRunning(thread.id)))); };
  const get = async (threadId: string): Promise<ThreadSnapshot | null> => { guard(); const thread = deps.getThread(threadId); return thread ? snapshotThread(thread, deps.isRunning(threadId)) : null; };
  const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    try {
      if (name === 'ct_send_message') { const threadId = String(args.thread_id ?? '').trim(); const { runId } = await send(threadId, { prompt: String(args.message ?? '').trim() }); if (args.wait === false) return `Message sent to thread ${threadId}. Running in the background.`; return formatRunResult(await wait(runId, { timeoutMs: toolTimeout(args) })); }
      if (name === 'ct_new_thread') { const prompt = String(args.message ?? '').trim(); if (!prompt) throw new ClaudeThreadsApiError('INVALID_ARGUMENT', 'message is required.'); const created = await api.threads.create({ title: String(args.title_hint ?? prompt).slice(0, 50) }); const { runId } = await send(created.threadId, { prompt }); if (args.wait === false) return `New thread started (id: ${created.threadId}). Running in the background.`; return formatRunResult(await wait(runId, { timeoutMs: toolTimeout(args) })); }
      if (name === 'ct_wait_for_thread') { const threadId = String(args.thread_id ?? '').trim(); const thread = deps.getThread(threadId); if (!thread) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', `Thread not found: ${threadId}`); const runId = latestRunByThread.get(threadId); return runId ? formatRunResult(await wait(runId, { timeoutMs: toolTimeout(args) })) : formatFinishedThread(thread); }
      if (name === 'ct_get_thread') { const threadId = String(args.thread_id ?? '').trim(); const thread = await get(threadId); if (!thread) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', `Thread not found: ${threadId}`); const lastN = Math.min(Math.max(1, Number(args.last_n) || 5), 20); return JSON.stringify({ ...thread, messages: thread.messages.slice(-lastN) }, null, 2); }
      if (name === 'ct_list_threads') { const status = String(args.status ?? 'all'); const limit = Math.min(Math.max(1, Number(args.limit) || 15), 30); let threads = [...await list()].sort((a, b) => b.updatedAt - a.updatedAt); threads = threads.filter(thread => toolStatus(thread) === status || status === 'all' || (status === 'waiting' && thread.status === 'waiting')).slice(0, limit); return JSON.stringify({ count: threads.length, threads }, null, 2); }
      if (name === 'ct_open_thread') { const threadId = String(args.thread_id ?? '').trim(); await api.threads.open(threadId); return `Opened thread ${threadId} in the Agent Threads panel.`; }
      return `Error: Agent Threads tool "${name}" is not available in public API v1.`;
    } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
  };
  const api: ClaudeThreadsApiV1 = freeze({ apiVersion: 1 as const, generation, capabilities: CAPABILITIES,
    threads: { list, get, create: async (input: CreateThreadInput) => { guard(); const thread = await deps.createThread(input); return freeze({ threadId: thread.id }); }, send, wait,
      open: async (threadId: string) => { guard(); if (!deps.getThread(threadId)) throw new ClaudeThreadsApiError('THREAD_NOT_FOUND', `Thread not found: ${threadId}`); await deps.openThread(threadId); },
      subscribe: (listener: (event: PublicThreadEvent) => void) => { guard(); listeners.add(listener); let disposed = false; return freeze({ dispose: () => { if (disposed) return; disposed = true; listeners.delete(listener); } }); } },
    orchestrators: { list: async () => { guard(); return freeze(deps.listOrchestrators().map(item => freeze({ ...item }))); }, dispatch: async (target, input) => { guard(); const threadId = await deps.resolveOrchestrator(target); if (!threadId || !deps.getThread(threadId)) throw new ClaudeThreadsApiError('ORCHESTRATOR_NOT_FOUND', `Orchestrator not found: ${target.id}`); return send(threadId, input); } },
    agentTools: { createBundle: (profile) => { guard(); if (profile !== 'voice-orchestration') throw new ClaudeThreadsApiError('INVALID_ARGUMENT', `Unknown tool profile: ${String(profile)}`); return freeze({ tools: VOICE_TOOLS, execute: executeTool }); } },
  });
  return { api, start: () => { guard(); if (started) return; started = true; deps.triggerHostEvent('claude-threads:api-ready', { apiVersion: 1, generation }); },
    stop: () => { if (stopped) return; stopped = true; active = false; deps.triggerHostEvent('claude-threads:api-stopping', { apiVersion: 1, generation }); unsubscribeInternal(); listeners.clear(); for (const record of runs.values()) if (!record.result) settle(record, { status: 'failed', runId: record.runId, threadId: record.threadId, error: publicFailure('PLUGIN_UNAVAILABLE') }); } };
}

function toolTimeout(args: Record<string, unknown>): number { return Math.min(Math.max(10, Number(args.timeout_secs) || 120), 300) * 1_000; }
function formatRunResult(result: RunResult): string { if (result.status === 'timed_out') return `Timed out waiting for thread ${result.threadId}.`; if (result.status === 'failed') return `Thread error: ${result.error.message}`; return result.finalMessage ? `Thread finished. Last message (${result.finalMessage.role}): ${result.finalMessage.content.slice(0, 800)}` : 'Thread finished (no messages).'; }
function formatFinishedThread(thread: Thread): string { const last = thread.messages.at(-1); return last ? `Thread finished. Last message (${last.role}): ${String(last.content).slice(0, 800)}` : 'Thread finished (no messages).'; }
function toolStatus(thread: ThreadSummary): string { if (thread.isRunning) return 'active'; if (thread.status === 'waiting' && thread.messageCount > 0) return thread.reviewed ? 'waiting' : 'waiting_new'; return thread.status; }

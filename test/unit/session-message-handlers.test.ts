/**
 * Tests for the new message handler callbacks added in the SDK alignment gap pass:
 *   - model_fallback   → onModelFallback
 *   - task_updated     → onTaskUpdated (patch applied to thread via ThreadManager)
 *   - tool_progress    → onToolProgress
 *   - memory_recall    → onMemoryRecall
 *   - commands_changed → onCommandsChanged
 *
 * Pattern: mock ClaudeSession so test code drives individual callbacks directly
 * through ThreadManager.sendMessage(), then assert on the ThreadEvents emitted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { ThreadEvent } from '../../src/ThreadManager';

// ─── hoisted mock state ───────────────────────────────────────────────────────

const mock = vi.hoisted(() => ({
  callbacks: null as SessionCallbacks | null,
  resolve: null as (() => void) | null,
}));

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(
      _prompt: string,
      _resumeSessionId: string | undefined,
      _cwd: unknown,
      _mode: unknown,
      _env: unknown,
      callbacks: SessionCallbacks,
    ): Promise<void> {
      mock.callbacks = callbacks;
      return new Promise<void>((res) => { mock.resolve = res; });
    }
    close() {}
    async interrupt() {}
  },
  // Re-export the real formatToolName / getToolIcon so other imports keep working
  formatToolName: (s: string) => s,
  getToolIcon: () => 'wrench',
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function makeManager() {
  return new ThreadManager({ ...DEFAULT_SETTINGS });
}

async function driveResponse(sessionId = 'sess-1') {
  const cb = mock.callbacks!;
  cb.onToken('ok');
  cb.onMessage('ok', []);
  cb.onDone(sessionId, 0.001, 1);
  mock.resolve!();
}

beforeEach(() => {
  mock.callbacks = null;
  mock.resolve = null;
});

// ─── model_fallback ───────────────────────────────────────────────────────────

describe('model_fallback → onModelFallback', () => {
  it('emits model_fallback event with trigger, fromModel, toModel', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onModelFallback!('overloaded', 'claude-opus-4', 'claude-sonnet-4-5');
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'model_fallback') as
      Extract<ThreadEvent, { type: 'model_fallback' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.trigger).toBe('overloaded');
    expect(evt!.fromModel).toBe('claude-opus-4');
    expect(evt!.toModel).toBe('claude-sonnet-4-5');
  });

  it('does not throw when onModelFallback is called without a subscriber', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');

    const sendP = manager.sendMessage(thread.id, 'hi');
    expect(() =>
      mock.callbacks!.onModelFallback!('overloaded', 'model-a', 'model-b'),
    ).not.toThrow();
    await driveResponse();
    await sendP;
  });
});

// ─── task_updated ─────────────────────────────────────────────────────────────

describe('task_updated → onTaskUpdated', () => {
  it('emits task_updated event with taskId and patch fields', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onTaskUpdated!('task-7', { status: 'completed', description: 'Done!' });
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'task_updated') as
      Extract<ThreadEvent, { type: 'task_updated' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.taskId).toBe('task-7');
    expect(evt!.status).toBe('completed');
    expect(evt!.description).toBe('Done!');
  });

  it('emits task_updated with error field when patch contains error', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onTaskUpdated!('task-3', { status: 'failed', error: 'Timeout after 30s' });
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'task_updated') as
      Extract<ThreadEvent, { type: 'task_updated' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.error).toBe('Timeout after 30s');
    expect(evt!.status).toBe('failed');
  });

  it('emits task_updated with only the provided patch fields', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onTaskUpdated!('task-1', { status: 'in_progress' });
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'task_updated') as
      Extract<ThreadEvent, { type: 'task_updated' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.status).toBe('in_progress');
    expect(evt!.description).toBeUndefined();
    expect(evt!.error).toBeUndefined();
  });
});

// ─── tool_progress ────────────────────────────────────────────────────────────

describe('tool_progress → onToolProgress', () => {
  it('emits tool_progress event with toolUseId, toolName, elapsedSeconds', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onToolProgress!('tool-use-abc', 'Bash', 14);
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'tool_progress') as
      Extract<ThreadEvent, { type: 'tool_progress' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.toolUseId).toBe('tool-use-abc');
    expect(evt!.toolName).toBe('Bash');
    expect(evt!.elapsedSeconds).toBe(14);
  });

  it('can fire multiple tool_progress events for the same tool', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onToolProgress!('tid-1', 'Bash', 5);
    mock.callbacks!.onToolProgress!('tid-1', 'Bash', 10);
    mock.callbacks!.onToolProgress!('tid-1', 'Bash', 15);
    await driveResponse();
    await sendP;

    const progressEvents = events.filter(e => e.type === 'tool_progress') as
      Extract<ThreadEvent, { type: 'tool_progress' }>[];
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents.map(e => e.elapsedSeconds)).toEqual([5, 10, 15]);
  });
});

// ─── memory_recall ────────────────────────────────────────────────────────────

describe('memory_recall → onMemoryRecall', () => {
  it('emits memory_recall event with paths and mode', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onMemoryRecall!(
      ['~/.claude/CLAUDE.md', '~/projects/my-app/.claude/CLAUDE.md'],
      'select',
    );
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'memory_recall') as
      Extract<ThreadEvent, { type: 'memory_recall' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.paths).toEqual(['~/.claude/CLAUDE.md', '~/projects/my-app/.claude/CLAUDE.md']);
    expect(evt!.mode).toBe('select');
  });

  it('emits memory_recall with synthesize mode', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onMemoryRecall!(['~/.claude/CLAUDE.md'], 'synthesize');
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'memory_recall') as
      Extract<ThreadEvent, { type: 'memory_recall' }> | undefined;
    expect(evt!.mode).toBe('synthesize');
  });
});

// ─── commands_changed ─────────────────────────────────────────────────────────

describe('commands_changed → onCommandsChanged', () => {
  it('emits commands_changed event with the command array', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const newCommands = [
      { name: 'brain-dump', description: 'Brain dump skill' },
      { name: 'deep-research', description: 'Deep research skill' },
    ];

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onCommandsChanged!(newCommands as never);
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'commands_changed') as
      Extract<ThreadEvent, { type: 'commands_changed' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.commands).toHaveLength(2);
    expect(evt!.commands[0].name).toBe('brain-dump');
    expect(evt!.commands[1].name).toBe('deep-research');
  });

  it('emits commands_changed with an empty array when all skills are removed', async () => {
    const manager = makeManager();
    const thread = manager.createThread('T');
    const events: ThreadEvent[] = [];
    manager.subscribe((_, e) => events.push(e));

    const sendP = manager.sendMessage(thread.id, 'hi');
    mock.callbacks!.onCommandsChanged!([]);
    await driveResponse();
    await sendP;

    const evt = events.find(e => e.type === 'commands_changed') as
      Extract<ThreadEvent, { type: 'commands_changed' }> | undefined;
    expect(evt).toBeDefined();
    expect(evt!.commands).toEqual([]);
  });
});

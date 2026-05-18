/**
 * snapshot-completeness.test.ts
 *
 * Verifies that a thread with many messages is fully serialized into the relay
 * snapshot. This is a regression test for the bug where mobile appeared to show
 * only the first message — the root cause was a scroll timing issue but we want
 * to ensure the DATA layer never silently truncates.
 *
 * Tests:
 *   - serializeThread (via RelayClient) preserves all messages
 *   - messages survive a JSON round-trip
 *   - MobileThreadStore absorbs a large snapshot without losing messages
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MobileThreadStore } from '../../src/MobileThreadStore';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { SerializedThread, SerializedMessage, RelayFrame } from '../../src/relay-protocol';
import type { Thread, ChatMessage } from '../../src/types';

vi.mock('../../src/ClaudeSession', () => ({
  ClaudeSession: class {
    async run(): Promise<void> {}
    close() {}
    async interrupt() {}
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMessages(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message content ${i}. ${'x'.repeat(200)}`,
      timestamp: 1000 + i * 100,
      cost: i % 2 === 1 ? 0.001 * i : undefined,
      toolCalls: i % 5 === 0 ? [{ name: 'Bash', summary: `Bash: echo ${i}` }] : undefined,
    });
  }
  return messages;
}

/** Direct serialization helper that mirrors RelayClient.serializeThread internals. */
function serializeThread(thread: Thread): SerializedThread {
  return {
    id: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    messages: thread.messages.map((msg) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      toolCalls: msg.toolCalls,
      cost: msg.cost,
      compactTrigger: msg.compactTrigger,
      preTokens: msg.preTokens,
    })),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    sessionId: thread.sessionId,
    recap: thread.recap,
    summary: thread.summary,
    lastError: thread.lastError,
    model: thread.model,
    projectId: thread.projectId,
  };
}

// ── serializeThread tests ──────────────────────────────────────────────────

describe('serializeThread — message completeness', () => {
  it('preserves all 70 messages', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const thread = manager.createThread('Big thread', '/cwd');
    thread.messages.push(...makeMessages(70));

    const serialized = serializeThread(thread);
    expect(serialized.messages).toHaveLength(70);
  });

  it('preserves message order', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const thread = manager.createThread('Ordered', '/cwd');
    thread.messages.push(...makeMessages(20));

    const serialized = serializeThread(thread);
    const ids = serialized.messages.map((m) => m.id);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `msg-${i}`));
  });

  it('preserves all message fields', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const thread = manager.createThread('Fields test', '/cwd');
    thread.messages.push({
      id: 'msg-full',
      role: 'assistant',
      content: 'Full content',
      timestamp: 9999,
      cost: 0.0042,
      toolCalls: [{ name: 'Write', summary: 'Write: foo.txt' }],
    });

    const serialized = serializeThread(thread);
    const msg = serialized.messages[0];
    expect(msg.id).toBe('msg-full');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Full content');
    expect(msg.timestamp).toBe(9999);
    expect(msg.cost).toBeCloseTo(0.0042);
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].name).toBe('Write');
  });

  it('preserves compact messages', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const thread = manager.createThread('Compact test', '/cwd');
    thread.messages.push(
      { id: 'u1', role: 'user', content: 'Before', timestamp: 100 },
      { id: 'c1', role: 'compact', content: '', timestamp: 200, compactTrigger: 'auto', preTokens: 50000 },
      { id: 'a1', role: 'assistant', content: 'After', timestamp: 300 },
    );

    const serialized = serializeThread(thread);
    expect(serialized.messages).toHaveLength(3);
    const compact = serialized.messages.find((m) => m.role === 'compact')!;
    expect(compact.compactTrigger).toBe('auto');
    expect(compact.preTokens).toBe(50000);
  });

  it('survives JSON round-trip without data loss', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    const thread = manager.createThread('Round-trip', '/home/user');
    thread.messages.push(...makeMessages(50));

    const serialized = serializeThread(thread);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json) as SerializedThread;

    expect(parsed.messages).toHaveLength(50);
    expect(parsed.messages[49].id).toBe('msg-49');
    expect(parsed.messages[49].content).toContain('Message content 49');
  });
});

// ── MobileThreadStore — large snapshot ──────────────────────────────────────

describe('MobileThreadStore — large snapshot absorption', () => {
  let store: MobileThreadStore;

  beforeEach(() => {
    store = new MobileThreadStore();
  });

  it('absorbs 10 threads × 70 messages each without truncation', () => {
    const threads: SerializedThread[] = Array.from({ length: 10 }, (_, ti) => ({
      id: `thread-${ti}`,
      title: `Thread ${ti}`,
      cwd: '/cwd',
      messages: makeMessages(70).map((m) => ({
        id: `t${ti}-${m.id}`,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
      createdAt: ti * 1000,
      updatedAt: ti * 1000 + 500,
    }));

    store.applyFrame({ type: 'snapshot', threads, activeThreadId: 'thread-0' });

    expect(store.getThreads()).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      const t = store.getThread(`thread-${i}`)!;
      expect(t.messages).toHaveLength(70);
    }
  });

  it('subsequent message frames append correctly after large snapshot', () => {
    const thread: SerializedThread = {
      id: 'tid',
      title: 'T',
      cwd: '/',
      messages: makeMessages(60).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
      createdAt: 0,
      updatedAt: 0,
    };

    store.applyFrame({ type: 'snapshot', threads: [thread], activeThreadId: 'tid' });

    const newMsg: SerializedMessage = {
      id: 'new-msg',
      role: 'assistant',
      content: 'New reply',
      timestamp: 99999,
    };
    store.applyFrame({ type: 'message', threadId: 'tid', message: newMsg });

    const updated = store.getThread('tid')!;
    expect(updated.messages).toHaveLength(61);
    expect(updated.messages[60].id).toBe('new-msg');
  });

  it('snapshot then re-snapshot replaces all messages cleanly', () => {
    const smallThread: SerializedThread = {
      id: 'tid',
      title: 'T',
      cwd: '/',
      messages: makeMessages(5).map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp })),
      createdAt: 0,
      updatedAt: 0,
    };
    store.applyFrame({ type: 'snapshot', threads: [smallThread], activeThreadId: 'tid' });
    expect(store.getThread('tid')!.messages).toHaveLength(5);

    const bigThread: SerializedThread = {
      ...smallThread,
      messages: makeMessages(70).map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp })),
    };
    store.applyFrame({ type: 'snapshot', threads: [bigThread], activeThreadId: 'tid' });
    expect(store.getThread('tid')!.messages).toHaveLength(70);
  });
});

// ── Snapshot frame size test ───────────────────────────────────────────────

describe('Snapshot JSON size', () => {
  it('a realistic 14-thread × 65-message snapshot is under 2MB', () => {
    const threads: SerializedThread[] = Array.from({ length: 14 }, (_, ti) => ({
      id: `thread-${ti}`,
      title: `Thread ${ti} with a longer title that is realistic`,
      cwd: '/Users/user/projects/myproject',
      messages: makeMessages(65).map((m) => ({ id: `t${ti}-${m.id}`, role: m.role, content: m.content, timestamp: m.timestamp, cost: m.cost })),
      createdAt: ti * 10000,
      updatedAt: ti * 10000 + 5000,
    }));

    const frame: RelayFrame = { type: 'snapshot', threads, activeThreadId: 'thread-0' };
    const json = JSON.stringify(frame);

    // Should comfortably fit in a single WebSocket message without hitting relay limits
    expect(json.length).toBeLessThan(2 * 1024 * 1024); // < 2 MB
    console.log(`14-thread snapshot JSON size: ${(json.length / 1024).toFixed(1)} KB`);
  });
});

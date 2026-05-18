/**
 * Tests for relay-protocol serialization/deserialization round-trips.
 *
 * The relay routes raw bytes — the plugin is responsible for JSON encode/decode.
 * These tests verify every frame type survives a JSON round-trip with the
 * correct structure.
 */
import { describe, it, expect } from 'vitest';
import type {
  RelayFrame,
  RemoteCommand,
  SerializedThread,
  SerializedMessage,
} from '../../src/relay-protocol';

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const sampleMessage: SerializedMessage = {
  id: 'msg-1',
  role: 'assistant',
  content: 'Hello world',
  timestamp: 1234567890,
  toolCalls: [{ name: 'Bash', summary: 'Bash: ls' }],
  cost: 0.0012,
};

const sampleThread: SerializedThread = {
  id: 'thread-1',
  title: 'Test thread',
  cwd: '/home/user',
  messages: [sampleMessage],
  createdAt: 1000000,
  updatedAt: 2000000,
  sessionId: 'session-abc',
  recap: 'Used Bash',
  model: 'sonnet',
};

describe('relay-protocol — RelayFrame round-trips', () => {
  it('snapshot', () => {
    const frame: RelayFrame = {
      type: 'snapshot',
      threads: [sampleThread],
      activeThreadId: 'thread-1',
    };
    const rt = roundTrip(frame);
    expect(rt.type).toBe('snapshot');
    expect((rt as typeof frame).threads).toHaveLength(1);
    expect((rt as typeof frame).threads[0].id).toBe('thread-1');
    expect((rt as typeof frame).activeThreadId).toBe('thread-1');
  });

  it('snapshot with null activeThreadId', () => {
    const frame: RelayFrame = { type: 'snapshot', threads: [], activeThreadId: null };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.activeThreadId).toBeNull();
  });

  it('token', () => {
    const frame: RelayFrame = { type: 'token', threadId: 'tid', text: 'Hello ' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.type).toBe('token');
    expect(rt.threadId).toBe('tid');
    expect(rt.text).toBe('Hello ');
  });

  it('tool_use', () => {
    const frame: RelayFrame = { type: 'tool_use', threadId: 'tid', name: 'Bash', summary: 'Bash: ls' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.name).toBe('Bash');
    expect(rt.summary).toBe('Bash: ls');
  });

  it('message', () => {
    const frame: RelayFrame = { type: 'message', threadId: 'tid', message: sampleMessage };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.message.id).toBe('msg-1');
    expect(rt.message.role).toBe('assistant');
    expect(rt.message.cost).toBeCloseTo(0.0012);
  });

  it('done', () => {
    const frame: RelayFrame = { type: 'done', threadId: 'tid' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.type).toBe('done');
  });

  it('error', () => {
    const frame: RelayFrame = { type: 'error', threadId: 'tid', error: 'Something went wrong' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.error).toBe('Something went wrong');
  });

  it('streaming_start', () => {
    const frame: RelayFrame = { type: 'streaming_start', threadId: 'tid' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.type).toBe('streaming_start');
  });

  it('thread_created', () => {
    const frame: RelayFrame = { type: 'thread_created', thread: sampleThread };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.thread.title).toBe('Test thread');
  });

  it('thread_deleted', () => {
    const frame: RelayFrame = { type: 'thread_deleted', threadId: 'tid' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.threadId).toBe('tid');
  });

  it('thread_renamed', () => {
    const frame: RelayFrame = { type: 'thread_renamed', threadId: 'tid', title: 'New Title' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.title).toBe('New Title');
  });

  it('permission_request', () => {
    const frame: RelayFrame = {
      type: 'permission_request',
      threadId: 'tid',
      toolName: 'Bash',
      detail: 'rm -rf /tmp/test',
      requestId: 'req-123',
    };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.toolName).toBe('Bash');
    expect(rt.requestId).toBe('req-123');
  });

  it('permission_resolved', () => {
    const frame: RelayFrame = { type: 'permission_resolved', threadId: 'tid', requestId: 'req-123' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.requestId).toBe('req-123');
  });

  it('status — compacting', () => {
    const frame: RelayFrame = { type: 'status', threadId: 'tid', status: 'compacting' };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.status).toBe('compacting');
  });

  it('status — null', () => {
    const frame: RelayFrame = { type: 'status', threadId: 'tid', status: null };
    const rt = roundTrip(frame) as typeof frame;
    expect(rt.status).toBeNull();
  });

  it('desktop_reconnected', () => {
    const frame: RelayFrame = { type: 'desktop_reconnected' };
    const rt = roundTrip(frame);
    expect(rt.type).toBe('desktop_reconnected');
  });

  it('pong', () => {
    const frame: RelayFrame = { type: 'pong' };
    const rt = roundTrip(frame);
    expect(rt.type).toBe('pong');
  });
});

describe('relay-protocol — RemoteCommand round-trips', () => {
  it('send_message', () => {
    const cmd: RemoteCommand = { type: 'send_message', threadId: 'tid', text: 'Hello Claude' };
    const rt = roundTrip(cmd) as typeof cmd;
    expect(rt.text).toBe('Hello Claude');
  });

  it('stop_session', () => {
    const cmd: RemoteCommand = { type: 'stop_session', threadId: 'tid' };
    const rt = roundTrip(cmd) as typeof cmd;
    expect(rt.type).toBe('stop_session');
  });

  it('resolve_permission — allow', () => {
    const cmd: RemoteCommand = { type: 'resolve_permission', threadId: 'tid', requestId: 'req-1', allow: true };
    const rt = roundTrip(cmd) as typeof cmd;
    expect(rt.allow).toBe(true);
    expect(rt.requestId).toBe('req-1');
  });

  it('resolve_permission — deny', () => {
    const cmd: RemoteCommand = { type: 'resolve_permission', threadId: 'tid', requestId: 'req-1', allow: false };
    const rt = roundTrip(cmd) as typeof cmd;
    expect(rt.allow).toBe(false);
  });

  it('create_thread with cwd', () => {
    const cmd: RemoteCommand = { type: 'create_thread', title: 'My thread', cwd: '/home/user' };
    const rt = roundTrip(cmd) as typeof cmd;
    expect(rt.title).toBe('My thread');
    expect(rt.cwd).toBe('/home/user');
  });

  it('create_thread without cwd', () => {
    const cmd: RemoteCommand = { type: 'create_thread', title: 'My thread' };
    const rt = roundTrip(cmd) as typeof cmd;
    expect(rt.cwd).toBeUndefined();
  });

  it('set_active_thread', () => {
    const cmd: RemoteCommand = { type: 'set_active_thread', threadId: 'tid' };
    const rt = roundTrip(cmd) as typeof cmd;
    expect(rt.threadId).toBe('tid');
  });

  it('ping', () => {
    const cmd: RemoteCommand = { type: 'ping' };
    const rt = roundTrip(cmd);
    expect(rt.type).toBe('ping');
  });
});

describe('relay-protocol — SerializedThread', () => {
  it('optional fields are preserved', () => {
    const thread: SerializedThread = {
      id: 't1',
      title: 'Test',
      cwd: '/cwd',
      messages: [],
      createdAt: 100,
      updatedAt: 200,
    };
    const rt = roundTrip(thread);
    expect(rt.sessionId).toBeUndefined();
    expect(rt.recap).toBeUndefined();
    expect(rt.model).toBeUndefined();
  });

  it('compact message round-trips', () => {
    const msg: SerializedMessage = {
      id: 'c1',
      role: 'compact',
      content: '',
      timestamp: 100,
      compactTrigger: 'auto',
      preTokens: 50000,
    };
    const rt = roundTrip(msg);
    expect(rt.role).toBe('compact');
    expect(rt.compactTrigger).toBe('auto');
    expect(rt.preTokens).toBe(50000);
  });
});

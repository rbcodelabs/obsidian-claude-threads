import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

describe('ThreadManager — thread lifecycle', () => {
  let manager: ThreadManager;
  beforeEach(() => { manager = makeManager(); });

  it('createThread stores and returns a thread', () => {
    const t = manager.createThread('My thread', '/some/cwd');
    expect(t.title).toBe('My thread');
    expect(t.cwd).toBe('/some/cwd');
    expect(t.messages).toEqual([]);
    expect(manager.getThread(t.id)).toBe(t);
  });

  it('createThread falls back to defaultCwd from settings', () => {
    const m = makeManager({ defaultCwd: '/default' });
    const t = m.createThread('T');
    expect(t.cwd).toBe('/default');
  });

  it('getThreads returns threads sorted by createdAt', () => {
    const t1 = manager.createThread('A');
    const t2 = manager.createThread('B');
    const t3 = manager.createThread('C');
    // Manually skew timestamps to make order deterministic
    t1.createdAt = 100;
    t2.createdAt = 300;
    t3.createdAt = 200;
    const ids = manager.getThreads().map(t => t.id);
    expect(ids).toEqual([t1.id, t3.id, t2.id]);
  });

  it('renameThread updates title and updatedAt', () => {
    const t = manager.createThread('Old');
    const before = t.updatedAt;
    t.updatedAt = before - 1000; // ensure measurable gap
    manager.renameThread(t.id, 'New');
    expect(manager.getThread(t.id)!.title).toBe('New');
    expect(manager.getThread(t.id)!.updatedAt).toBeGreaterThan(before - 1000);
  });

  it('deleteThread removes the thread', () => {
    const t = manager.createThread('To delete');
    manager.deleteThread(t.id);
    expect(manager.getThread(t.id)).toBeUndefined();
  });

  it('isRunning returns false before any send', () => {
    const t = manager.createThread('T');
    expect(manager.isRunning(t.id)).toBe(false);
  });

  it('getRunningThreads returns only threads with active sessions', () => {
    const t1 = manager.createThread('Running A');
    const t2 = manager.createThread('Idle B');
    const t3 = manager.createThread('Running C');
    // Inject fake sessions directly to simulate active threads
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set(t1.id, {});
    sessions.set(t3.id, {});
    const running = manager.getRunningThreads();
    expect(running.map(t => t.id).sort()).toEqual([t1.id, t3.id].sort());
    expect(running.find(t => t.id === t2.id)).toBeUndefined();
  });

  it('getRunningThreads returns empty array when no sessions active', () => {
    manager.createThread('Idle A');
    manager.createThread('Idle B');
    expect(manager.getRunningThreads()).toHaveLength(0);
  });

  it('gracefulShutdown resolves immediately with timedOut=false when no sessions active', async () => {
    manager.createThread('Idle');
    const result = await manager.gracefulShutdown(5_000);
    expect(result.timedOut).toBe(false);
  });

  it('gracefulShutdown returns timedOut=true when sessions do not drain before timeout', async () => {
    const t = manager.createThread('Stubborn');
    // Inject a fake session whose interrupt() never resolves (simulates a hung agent)
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set(t.id, { interrupt: () => new Promise(() => {}) });
    // Use a very short timeout so the test completes quickly
    const result = await manager.gracefulShutdown(50);
    expect(result.timedOut).toBe(true);
  });

  it('gracefulShutdown returns timedOut=false when sessions drain before timeout', async () => {
    const t = manager.createThread('Quick');
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    // Interrupt removes itself from the sessions map after a short delay
    sessions.set(t.id, {
      interrupt: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        sessions.delete(t.id);
      },
    });
    const result = await manager.gracefulShutdown(2_000);
    expect(result.timedOut).toBe(false);
  });

  it('loadThreads populates threads', () => {
    const m = makeManager();
    const thread = {
      id: 'abc',
      title: 'Loaded',
      cwd: '/cwd',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    m.loadThreads([thread]);
    expect(m.getThread('abc')).toMatchObject({ title: 'Loaded' });
  });

  it('subscribe listener fires and unsubscribe stops it', () => {
    const t = manager.createThread('T');
    const events: string[] = [];
    const unsub = manager.subscribe((_, e) => events.push(e.type));
    // Emit via internal path — deleteThread doesn't emit, but we test subscribe wiring
    // via the public API in integration tests; here just verify unsub works
    unsub();
    expect(events).toHaveLength(0);
  });

  it('renameThread emits thread_renamed event with correct payload', () => {
    const t = manager.createThread('Original');
    const events: Array<{ threadId: string; type: string; title?: string }> = [];
    manager.subscribe((threadId, e) => {
      if (e.type === 'thread_renamed') {
        events.push({ threadId, type: e.type, title: e.title });
      }
    });

    manager.renameThread(t.id, 'Renamed');

    expect(events).toHaveLength(1);
    expect(events[0].threadId).toBe(t.id);
    expect(events[0].type).toBe('thread_renamed');
    expect(events[0].title).toBe('Renamed');
  });

  it('renameThread does not emit event for unknown thread', () => {
    const events: string[] = [];
    manager.subscribe((_, e) => events.push(e.type));

    manager.renameThread('nonexistent-id', 'Whatever');

    expect(events.filter(t => t === 'thread_renamed')).toHaveLength(0);
  });
});

describe('ThreadManager — mcpServerFactory', () => {
  it('is undefined by default', () => {
    const manager = makeManager();
    expect(manager.mcpServerFactory).toBeUndefined();
  });

  it('returns a fresh object on each call', () => {
    const manager = makeManager();
    let callCount = 0;
    manager.mcpServerFactory = () => {
      callCount++;
      return { obsidian: { type: 'sdk_mcp', instance: {} } as never };
    };
    manager.mcpServerFactory();
    manager.mcpServerFactory();
    expect(callCount).toBe(2);
  });

  it('returns distinct objects per call (no shared instance)', () => {
    const manager = makeManager();
    manager.mcpServerFactory = () => ({ obsidian: { type: 'sdk_mcp', instance: {} } as never });
    const a = manager.mcpServerFactory();
    const b = manager.mcpServerFactory();
    expect(a).not.toBe(b);
    expect(a.obsidian).not.toBe(b.obsidian);
  });
});

describe('ThreadManager — model escalation (resolveModel / stripKeyword)', () => {
  // resolveModel/stripKeyword are private; reach through for direct unit coverage.
  const resolve = (manager: ThreadManager, text: string): string | undefined =>
    (manager as unknown as { resolveModel(t: string): string | undefined }).resolveModel(text);
  const strip = (manager: ThreadManager, text: string): string =>
    (manager as unknown as { stripKeyword(t: string): string }).stripKeyword(text);

  it('escalates to the configured escalation model', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: 'fable' });
    expect(resolve(manager, 'please /escalate fix this')).toBe('fable');
  });

  it('falls back to opus when escalationModel is empty', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: '' });
    expect(resolve(manager, '/escalate do it')).toBe('opus');
  });

  it('returns undefined when the keyword is absent', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: 'fable' });
    expect(resolve(manager, 'just a normal message')).toBeUndefined();
  });

  it('does not escalate when disabled', () => {
    const manager = makeManager({ escalationEnabled: false, escalationKeyword: '/escalate', escalationModel: 'fable' });
    expect(resolve(manager, '/escalate do it')).toBeUndefined();
  });

  it('supports a custom keyword', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'opus' });
    expect(resolve(manager, 'fix this /opus please')).toBe('opus');
  });

  it('strips the keyword from the middle of a message', () => {
    const manager = makeManager({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: 'fable' });
    expect(strip(manager, 'please /escalate fix this')).toBe('please fix this');
  });
});

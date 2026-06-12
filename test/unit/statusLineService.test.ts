import { describe, it, expect } from 'vitest';
import { StatusLineService, type StatusLineExec } from '../../src/StatusLineService';
import type { ThreadManager } from '../../src/ThreadManager';
import type { Thread } from '../../src/types';

// ── Fake ThreadManager (only the surface StatusLineService touches) ──────────

function makeThread(id: string, cwd: string): Thread {
  return { id, title: id, cwd, messages: [], createdAt: 0, updatedAt: 0 } as Thread;
}

function fakeManager(threads: Thread[]) {
  const listeners = new Set<(id: string, ev: { type: string }) => void>();
  const applied: Array<{ id: string; tags: unknown }> = [];
  const mgr = {
    subscribe(l: (id: string, ev: { type: string }) => void) { listeners.add(l); return () => listeners.delete(l); },
    emit(id: string, ev: { type: string }) { for (const l of listeners) l(id, ev); },
    getThreads() { return threads; },
    getThread(id: string) { return threads.find((t) => t.id === id); },
    applyStatusTags(id: string, tags: unknown) { applied.push({ id, tags }); return false; },
    _applied: applied,
    _listenerCount: () => listeners.size,
  };
  return mgr;
}

/** Async fake exec: records calls, tracks peak concurrency, replies on the next macrotask. */
function makeExec(stdout: string | (() => string), opts: { err?: boolean } = {}) {
  const state = { calls: [] as string[], active: 0, maxActive: 0 };
  const exec: StatusLineExec = (cmd, _opts, cb) => {
    state.calls.push(cmd);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    setTimeout(() => {
      state.active--;
      const out = typeof stdout === 'function' ? stdout() : stdout;
      cb(opts.err ? new Error('boom') : null, out, '');
    }, 0);
    return { stdin: { write() {}, end() {} } };
  };
  return { exec, state };
}

const baseDeps = (exec: StatusLineExec, over: Partial<Parameters<typeof StatusLineService.prototype.constructor>[2]> = {}) => ({
  exec,
  now: () => 1000,
  homedir: () => '/home/mock',
  isMobile: false,
  ...over,
});

const config = (cmd = 'statusline.sh', intervalMs?: number) => () => ({ statusLineCommand: cmd, statusLineIntervalMs: intervalMs });

describe('StatusLineService — mobile no-op', () => {
  it('does not subscribe, exec, or apply on mobile', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { exec, state } = makeExec('[]');
    const svc = new StatusLineService(mgr as unknown as ThreadManager, config(), { ...baseDeps(exec), isMobile: true });
    svc.start();
    await svc.pollAll();
    expect(state.calls).toHaveLength(0);
    expect(mgr._listenerCount()).toBe(0);
    expect(mgr._applied).toHaveLength(0);
  });
});

describe('StatusLineService — cwd coalescing', () => {
  it('runs the script once per cwd and applies to every thread sharing it', async () => {
    const threads = [makeThread('a', '/repo'), makeThread('b', '/repo'), makeThread('c', '/other')];
    const mgr = fakeManager(threads);
    const { exec, state } = makeExec('[{"label":"main","kind":"branch"}]');
    const svc = new StatusLineService(mgr as unknown as ThreadManager, config(), baseDeps(exec));
    await svc.pollAll();
    // Two distinct cwds → two execs.
    expect(state.calls).toHaveLength(2);
    // Applied to all three threads (a, b share /repo; c on /other).
    const ids = mgr._applied.map((x) => x.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('passes parsed tags through to applyStatusTags', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { exec } = makeExec('[{"label":"PR #7","url":"https://x/pull/7","kind":"pr"}]');
    const svc = new StatusLineService(mgr as unknown as ThreadManager, config(), baseDeps(exec));
    await svc.pollAll();
    expect(mgr._applied[0].tags).toEqual([{ label: 'PR #7', url: 'https://x/pull/7', kind: 'pr' }]);
  });
});

describe('StatusLineService — concurrency cap', () => {
  it('runs at most 4 scripts concurrently', async () => {
    const threads = Array.from({ length: 6 }, (_, i) => makeThread(`t${i}`, `/repo${i}`));
    const mgr = fakeManager(threads);
    const { exec, state } = makeExec('[]');
    const svc = new StatusLineService(mgr as unknown as ThreadManager, config(), baseDeps(exec));
    await svc.pollAll();
    expect(state.calls).toHaveLength(6);
    expect(state.maxActive).toBeLessThanOrEqual(4);
    expect(state.maxActive).toBe(4);
  });
});

describe('StatusLineService — caching', () => {
  it('reuses a cached result within the TTL (no second exec)', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    let clock = 1000;
    const { exec, state } = makeExec('[]');
    const svc = new StatusLineService(mgr as unknown as ThreadManager, config(), { ...baseDeps(exec), now: () => clock });
    await svc.pollAll();
    expect(state.calls).toHaveLength(1);
    clock += 1000; // within 5s TTL
    await svc.pollAll();
    expect(state.calls).toHaveLength(1); // cache hit, no new exec
    clock += 10_000; // past TTL
    await svc.pollAll();
    expect(state.calls).toHaveLength(2);
  });
});

describe('StatusLineService — error handling', () => {
  it('keeps previous tags (does not apply) when exec errors', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { exec, state } = makeExec('', { err: true });
    const svc = new StatusLineService(mgr as unknown as ThreadManager, config(), baseDeps(exec));
    await svc.pollAll();
    expect(state.calls).toHaveLength(1);
    expect(mgr._applied).toHaveLength(0);
  });

  it('does nothing when the command is empty', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { exec, state } = makeExec('[]');
    const svc = new StatusLineService(mgr as unknown as ThreadManager, config(''), baseDeps(exec));
    await svc.pollAll();
    expect(state.calls).toHaveLength(0);
  });
});

describe('StatusLineService — stdin contract', () => {
  function capturingExec() {
    const captured: string[] = [];
    const exec: StatusLineExec = (_cmd, _opts, cb) => {
      setTimeout(() => cb(null, '[]', ''), 0);
      return { stdin: { write: (s: string) => { captured.push(s); }, end() {} } };
    };
    return { exec, captured };
  }

  it('passes cwd, workspace.current_dir, and provider on stdin', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { exec, captured } = capturingExec();
    const svc = new StatusLineService(
      mgr as unknown as ThreadManager,
      () => ({ statusLineCommand: 'x.sh', provider: 'bedrock' }),
      baseDeps(exec),
    );
    await svc.pollAll();
    const parsed = JSON.parse(captured.join(''));
    expect(parsed.cwd).toBe('/repo');
    expect(parsed.workspace.current_dir).toBe('/repo');
    expect(parsed.provider).toBe('bedrock');
  });

  it('defaults provider to "claude" when unset', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { exec, captured } = capturingExec();
    const svc = new StatusLineService(
      mgr as unknown as ThreadManager,
      () => ({ statusLineCommand: 'x.sh' }),
      baseDeps(exec),
    );
    await svc.pollAll();
    expect(JSON.parse(captured.join('')).provider).toBe('claude');
  });
});

describe('StatusLineService — pokeThread', () => {
  it('bypasses cache and refreshes the thread cwd', async () => {
    const mgr = fakeManager([makeThread('a', '/repo')]);
    const { exec, state } = makeExec('[]');
    const svc = new StatusLineService(mgr as unknown as ThreadManager, config(), baseDeps(exec));
    await svc.pollAll();
    expect(state.calls).toHaveLength(1);
    svc.pokeThread('a');
    await new Promise((r) => setTimeout(r, 5));
    expect(state.calls).toHaveLength(2); // cache cleared → re-exec
  });
});

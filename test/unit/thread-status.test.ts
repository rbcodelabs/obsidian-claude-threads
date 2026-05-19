import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { Thread } from '../../src/types';

function makeManager(overrides = {}) {
  return new ThreadManager({ ...DEFAULT_SETTINGS, ...overrides });
}

/** Minimal thread fixture — mirrors the shape loadThreads expects. */
function makeThreadFixture(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'fixture-id',
    title: 'Fixture',
    cwd: '/cwd',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('ThreadManager — thread status field', () => {
  let manager: ThreadManager;
  beforeEach(() => { manager = makeManager(); });

  // ── createThread ─────────────────────────────────────────────────────────────

  describe('createThread', () => {
    it("sets status to 'waiting' on a new thread", () => {
      const thread = manager.createThread('New Thread', '/cwd');
      expect(thread.status).toBe('waiting');
    });

    it("sets status to 'waiting' even when no cwd is given", () => {
      const thread = manager.createThread('T');
      expect(thread.status).toBe('waiting');
    });
  });

  // ── loadThreads ───────────────────────────────────────────────────────────────

  describe('loadThreads', () => {
    it("migrates a thread with no status field to 'waiting'", () => {
      // Arrange: a thread serialised before the status field existed
      const legacy = makeThreadFixture({ id: 'legacy', status: undefined });

      // Act
      manager.loadThreads([legacy]);

      // Assert
      expect(manager.getThread('legacy')!.status).toBe('waiting');
    });

    it("migrates a thread whose status is explicitly null to 'waiting'", () => {
      // Covers the edge case where null was stored instead of undefined
      const corrupt = makeThreadFixture({ id: 'corrupt', status: null as unknown as undefined });

      manager.loadThreads([corrupt]);

      expect(manager.getThread('corrupt')!.status).toBe('waiting');
    });

    it("preserves an explicit 'error' status — does not reset to 'waiting'", () => {
      const errored = makeThreadFixture({ id: 'err', status: 'error' });

      manager.loadThreads([errored]);

      expect(manager.getThread('err')!.status).toBe('error');
    });

    it("preserves 'archived' status — does not reset to 'waiting'", () => {
      // This is the critical regression guard: archived threads must NOT be
      // un-archived by migration.
      const archived = makeThreadFixture({ id: 'arc', status: 'archived' });

      manager.loadThreads([archived]);

      expect(manager.getThread('arc')!.status).toBe('archived');
    });

    it("preserves an explicit 'waiting' status unchanged", () => {
      const waiting = makeThreadFixture({ id: 'w', status: 'waiting' });

      manager.loadThreads([waiting]);

      expect(manager.getThread('w')!.status).toBe('waiting');
    });

    it('migrates only the statusless threads when loading a mixed batch', () => {
      const threads: Thread[] = [
        makeThreadFixture({ id: 'no-status', status: undefined }),
        makeThreadFixture({ id: 'archived', status: 'archived' }),
        makeThreadFixture({ id: 'errored', status: 'error' }),
      ];

      manager.loadThreads(threads);

      expect(manager.getThread('no-status')!.status).toBe('waiting');
      expect(manager.getThread('archived')!.status).toBe('archived');
      expect(manager.getThread('errored')!.status).toBe('error');
    });
  });
});

/**
 * save-settings-race.test.ts
 *
 * Regression tests for the saveSettings() write-serialization fix.
 *
 * Before this fix, ClaudeThreadsPlugin.saveSettings() had no lock/queue:
 * every caller independently recomputed `settings.threads`/`settings.projects`
 * from the manager and called `await this.saveData(this.settings)` directly.
 * With no serialization, two overlapping calls could race — whichever disk
 * write FINISHED last won, even if it started earlier. A slow background
 * save that began before a thread was archived could complete AFTER the
 * correct post-archive write and silently clobber it back to stale state,
 * resurrecting a "closed" thread.
 *
 * These tests exercise the REAL ClaudeThreadsPlugin.prototype.saveSettings()/
 * runSaveLoop() implementation (not a reimplementation) by constructing a
 * minimal instance via Object.create(ClaudeThreadsPlugin.prototype) and
 * setting only the fields saveSettings() touches (`manager`, `settings`,
 * `saveData`) — bypassing Obsidian's Plugin constructor, which needs a real
 * App/manifest this test doesn't need.
 *
 * The mock models "disk" as a shared value that's overwritten whenever a
 * saveData() call's write actually COMPLETES (its promise resolves) — not
 * whenever it was CALLED — because that's what determines the real race:
 * content is captured synchronously at call time (mirrors a real
 * JSON.stringify happening before an async fs write), but which write lands
 * on disk last is decided by completion order, which the test controls
 * explicitly via deferred promises.
 */

import { describe, it, expect, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

/** A deferred promise whose resolution the test controls explicitly. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

interface SavedSettingsShape {
  threads: Array<{ id: string }>;
}

/**
 * Builds a minimal ClaudeThreadsPlugin instance with a real ThreadManager
 * wired in, and a saveData mock whose completion order (not call order)
 * determines the final "disk" state.
 */
function makePlugin() {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  plugin.manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  plugin.settings = { ...DEFAULT_SETTINGS };
  const disk: { state: SavedSettingsShape | null } = { state: null };
  const saveData = vi.fn();
  (plugin as unknown as { saveData: typeof saveData }).saveData = saveData;
  return { plugin, saveData, disk };
}

/** Registers the next saveData() call to snapshot its payload immediately
 * (synchronous, matching real JSON.stringify-before-write semantics) but
 * only "land" on `disk.state` once `gate` resolves. */
function queueWrite(saveData: ReturnType<typeof vi.fn>, disk: { state: SavedSettingsShape | null }, gate: Promise<void>) {
  saveData.mockImplementationOnce((data: SavedSettingsShape) => {
    const snapshot = JSON.parse(JSON.stringify(data)) as SavedSettingsShape;
    return gate.then(() => { disk.state = snapshot; });
  });
}

describe('ClaudeThreadsPlugin.saveSettings() — serialized write queue', () => {
  it('a slow overlapping write does not clobber a later write with stale thread state (regression: archive resurrection)', async () => {
    const { plugin, saveData, disk } = makePlugin();
    const thread = plugin.manager.createThread('to be archived', '/tmp');

    const gate1 = deferred<void>();
    const gate2 = deferred<void>();

    // Call #1: a routine background autosave starts while the thread still
    // exists. Its write is slow (held open on gate1).
    queueWrite(saveData, disk, gate1.promise);
    const save1 = plugin.saveSettings();

    // Before #1's write completes, the thread gets "archived" (deleted from
    // the manager) and a second save is triggered — e.g. closeThread().
    plugin.manager.deleteThread(thread.id);
    queueWrite(saveData, disk, gate2.promise);
    const save2 = plugin.saveSettings();

    // The correct, fresher write (#2) completes FIRST...
    gate2.resolve();
    // ...then the stale write (#1) completes LAST. Pre-fix (two independent,
    // unserialized writes), this is exactly the scenario that resurrects the
    // thread: #1's stale payload — captured before the archive — physically
    // lands on disk after #2's correct payload, silently overwriting it.
    gate1.resolve();

    await Promise.all([save1, save2]);

    expect(disk.state?.threads.find((t) => t.id === thread.id)).toBeUndefined();
  });

  it('coalesces a burst of rapid-fire calls into fewer saveData writes, and the last write to land reflects the freshest state', async () => {
    const { plugin, saveData, disk } = makePlugin();
    const t1 = plugin.manager.createThread('one', '/tmp');

    // First write is held open so subsequent calls stack up behind it.
    const gate = deferred<void>();
    queueWrite(saveData, disk, gate.promise);

    const p1 = plugin.saveSettings();
    const p2 = plugin.saveSettings();
    const p3 = plugin.saveSettings();

    // Mutate state between the stacked-up calls — a re-run triggered by the
    // coalescing should still pick this up even though no *new*
    // saveSettings() call happens after it.
    plugin.manager.deleteThread(t1.id);
    const t2 = plugin.manager.createThread('two', '/tmp');

    // If the fix coalesces correctly, at most one more real write happens
    // after this one drains (the re-run), so one more queued gate covers it.
    const gate2 = deferred<void>();
    queueWrite(saveData, disk, gate2.promise);
    gate.resolve();
    gate2.resolve();

    await Promise.all([p1, p2, p3]);

    // Three saveSettings() calls should not produce three saveData writes.
    expect(saveData.mock.calls.length).toBeLessThan(3);

    expect(disk.state?.threads.find((t) => t.id === t1.id)).toBeUndefined();
    expect(disk.state?.threads.find((t) => t.id === t2.id)).toBeDefined();
  });
});

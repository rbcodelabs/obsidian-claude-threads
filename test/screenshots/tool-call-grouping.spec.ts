import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

// Fixture: 'thread-tool-grouping' (test/harness/fixtures.ts) — a single
// assistant message with 15 tool calls spanning exploring/editing/planning/
// researching/searching activity kinds, including one failed Edit (so the
// editing group auto-expands) and three isolated calls (WebFetch, Write, a
// trailing Read) that fall outside any group.
//
// Group order in the fixture (0-indexed among .ct-tool-group elements):
//   0 = exploring (Read,Read,Read,Grep,Bash) — collapsed by default, no error
//   1 = editing (Edit,Edit,Edit) — has an error, auto-expanded
//   2 = planning (TaskCreate,TaskUpdate) — collapsed by default, no error
//   3 = searching (ToolSearch,Agent) — collapsed by default, no error

test.describe('Tool-call grouping', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-tool-grouping'));
    await page.waitForSelector('.ct-tool-group');
    await page.waitForTimeout(200);
  });

  test('groups render collapsed by default, except the group containing an error', async ({ page }) => {
    // Non-error groups start collapsed (.ct-full-content has .ct-hidden)
    const exploringGroup = page.locator('.ct-tool-group').nth(0);
    await expect(exploringGroup.locator('.ct-full-content')).toHaveClass(/ct-hidden/);

    // The editing group contains a failed Edit and should already be expanded
    const editingGroup = page.locator('.ct-tool-group').nth(1);
    await expect(editingGroup.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    await expect(page).toHaveScreenshot('tool-call-grouping-collapsed.png', { fullPage: true });
  });

  test('clicking a group header expands it', async ({ page }) => {
    const exploringGroup = page.locator('.ct-tool-group').nth(0);
    await exploringGroup.locator('.ct-expand-btn').click();
    await expect(exploringGroup.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('tool-call-grouping-expanded.png', { fullPage: true });
  });

  test('error group auto-expands and is visually flagged', async ({ page }) => {
    const editingGroup = page.locator('.ct-tool-group').nth(1);
    await expect(editingGroup.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
    await expect(editingGroup.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-error/);
    // At least one pill inside the group carries the error tint class.
    await expect(editingGroup.locator('.ct-tool-pill.ct-tool-error')).toHaveCount(1);
    await expect(editingGroup).toHaveScreenshot('tool-call-grouping-error-expanded.png');
  });

  test('isolated calls still render as plain ungrouped pills', async ({ page }) => {
    // Direct .ct-tool-pill children of .ct-tools are the isolated (non-grouped)
    // calls — WebFetch, Write, and the trailing Read in this fixture.
    const isolatedPills = page.locator('.ct-tools > .ct-tool-pill');
    await expect(isolatedPills).toHaveCount(3);
    await expect(isolatedPills.first()).toHaveScreenshot('tool-call-grouping-isolated-pill.png');
  });
});

// ─── Live (in-progress turn) tool-call grouping ─────────────────────────────
// Drives real ThreadEvents via window.__emitEvent (test/harness/index.ts) into
// an empty thread (fixture 'thread-live-tool-grouping') to exercise the LIVE
// rendering path (ThreadsView.renderLiveToolCalls/scheduleLiveToolsRender),
// not just the finalized-message path covered above. This is the actual pain
// point the feature closes: before this change, tool calls only grouped after
// a message settled — during a long-running turn they rendered as an
// ever-growing flat pill list with no cap.

test.describe('Live tool-call grouping', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-live-tool-grouping'));
    await page.waitForTimeout(200);
    // Fire the user message that kicks off the turn, exactly like a real send
    // would — this both matches production event ordering and clears the
    // "Ask Claude anything" empty-state placeholder (handled by the
    // 'user_message_added' case, which no other event in this suite touches)
    // so the live tool-call area renders against a realistic, non-empty view.
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const threadId = 'thread-live-tool-grouping';
      const message = { id: 'live-user-msg', role: 'user', content: 'Do the thing', timestamp: Date.now() };
      manager.getThread(threadId).messages.push(message);
      (window as any).__emitEvent(threadId, { type: 'user_message_added', message });
    });
    await page.waitForTimeout(100);
  });

  test('a burst of same-kind live tool calls collapses into one bounded group instead of growing 1:1 with event count', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      // Multiple tool NAMES, all classified as the 'exploring' activity kind
      // (see getActivityKind in src/toolNameUtils.ts) so they all merge into
      // a single run.
      const names = ['Read', 'Grep', 'Bash', 'Glob'];
      for (let i = 0; i < 50; i++) {
        emit(threadId, {
          type: 'tool_use',
          record: {
            name: names[i % names.length],
            summary: `call #${i}`,
            timestamp: Date.now(),
            toolUseId: `live-${i}`,
            status: 'pending',
          },
        });
      }
    });
    // scheduleLiveToolsRender debounces at 80ms — wait past it with margin.
    await page.waitForTimeout(300);

    // All 50 calls collapse into exactly one live group: top-level .ct-tools
    // children stay bounded instead of growing 1:1 with the event count.
    await expect(page.locator('.ct-tools > *')).toHaveCount(1);
    const group = page.locator('.ct-tool-group').first();
    await expect(group).toBeVisible();
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Exploring (50)');
    // "Still running" affordance on the header — every child is still pending.
    await expect(group.locator('.ct-tool-group-header')).toHaveClass(/ct-tool-active/);
    // Collapsed by default — a long run of pending (not erroring) calls must
    // NOT force-expand just because it's live.
    await expect(group.locator('.ct-full-content')).toHaveClass(/ct-hidden/);

    await expect(page).toHaveScreenshot('tool-call-grouping-live-collapsed.png', { fullPage: true });
  });

  test('the in-flight tool still shows its own active indicator alongside resolved siblings', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: 'a.ts', timestamp: Date.now(), toolUseId: 'live-1', status: 'pending' } });
      emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: 'b.ts', timestamp: Date.now(), toolUseId: 'live-2', status: 'pending' } });
    });
    await page.waitForTimeout(300);
    // In real usage, ClaudeSession finds the ToolCallRecord by toolUseId and
    // mutates `record.status` IN PLACE on the same object instance already
    // held in streamingBuffers — the tool_result_status event that follows
    // carries no status data of its own for ThreadsView to apply; it's purely
    // a "go re-render" signal (see the handler's comment in ThreadsView.ts).
    // The harness has no real ClaudeSession, so replicate that same-object
    // mutation here before firing the event, or the pill would never flip.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const buf = view['streamingBuffers'].get('thread-live-tool-grouping');
      const record = buf.tools.find((t: any) => t.toolUseId === 'live-1');
      record.status = 'success';
      (window as any).__emitEvent('thread-live-tool-grouping', { type: 'tool_result_status', toolUseId: 'live-1', status: 'success' });
    });
    await page.waitForTimeout(300);

    const group = page.locator('.ct-tool-group').first();
    await group.locator('.ct-expand-btn').click();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    const pills = group.locator('.ct-full-content .ct-tool-pill');
    await expect(pills).toHaveCount(2);
    await expect(pills.nth(0)).toHaveClass(/ct-tool-success/);
    await expect(pills.nth(1)).toHaveClass(/ct-tool-active/);
  });

  test('a group expanded mid-turn stays expanded as more same-kind calls arrive (stable liveToolGroupKey)', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      emit(threadId, { type: 'streaming_start' });
      for (let i = 0; i < 3; i++) {
        emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: `#${i}`, timestamp: Date.now(), toolUseId: `live-${i}`, status: 'pending' } });
      }
    });
    await page.waitForTimeout(300);

    const group = page.locator('.ct-tool-group').first();
    await group.locator('.ct-expand-btn').click();
    await expect(group.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);

    // More same-kind calls arrive — the group rebuilds from scratch (fresh DOM
    // nodes every debounced render), but since it's keyed by the first call's
    // toolUseId + activity kind (liveToolGroupKey), the SAME group identity
    // persists across rebuilds and the freshly-built header/full-content
    // still read as "expanded".
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      for (let i = 3; i < 8; i++) {
        emit(threadId, { type: 'tool_use', record: { name: 'Bash', summary: `#${i}`, timestamp: Date.now(), toolUseId: `live-${i}`, status: 'pending' } });
      }
    });
    await page.waitForTimeout(300);

    const groupAfter = page.locator('.ct-tool-group').first();
    await expect(groupAfter.locator('.ct-compressed-summary')).toHaveText('Exploring (8)');
    await expect(groupAfter.locator('.ct-full-content')).not.toHaveClass(/ct-hidden/);
  });

  test('switching away and back mid-turn restores the same grouped view, not a flat replay', async ({ page }) => {
    await page.evaluate(() => {
      const emit = (window as any).__emitEvent;
      const threadId = 'thread-live-tool-grouping';
      // beforeEach already seeded a user message (thread.messages is non-empty),
      // which matters here specifically: renderMessages() early-returns to the
      // empty-state placeholder when thread.messages IS empty — before it even
      // checks isRunning — so without that seed the restore-on-switch path
      // below would never be reached.
      // Mark the thread as running so renderMessages()'s restore-on-switch
      // path (gated on manager.isRunning) actually fires when we switch back.
      (window as any).__setThreadRunning(threadId, true);
      emit(threadId, { type: 'streaming_start' });
      for (let i = 0; i < 6; i++) {
        emit(threadId, { type: 'tool_use', record: { name: 'Read', summary: `#${i}`, timestamp: Date.now(), toolUseId: `live-${i}`, status: 'pending' } });
      }
    });
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-tools > *')).toHaveCount(1);

    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as any).__view.focusThread('thread-live-tool-grouping'));
    await page.waitForTimeout(200);

    // Restored view groups exactly like the live view did before the switch —
    // no flat per-tool-pill replay.
    await expect(page.locator('.ct-tools > *')).toHaveCount(1);
    const group = page.locator('.ct-tool-group').first();
    await expect(group.locator('.ct-compressed-summary')).toHaveText('Exploring (6)');
  });
});

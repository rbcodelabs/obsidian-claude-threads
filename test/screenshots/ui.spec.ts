import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

test.describe('Claude Threads UI', () => {
  // Pin Date.now()/new Date() to the fixture epoch (test/harness/fixtures.ts)
  // so relative labels ("5m ago", "Last active …") and same-day timestamp
  // rendering are deterministic — without this, baselines with "Xd ago" text
  // drift every midnight and timestamp prefixes depend on the run date.
  // setFixedTime fakes only the clock; real timers keep running.
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  test('main view', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the HipTrip thread which shows a markdown table (use API since tabs were removed)
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('main-view.png', { fullPage: true });
  });

  test('native agent workspace', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => {
      const view = (window as any).__view;
      const manager = view.manager;
      const threadId = 'thread-fix-auth';
      const store = manager.agentRuns;
      const parent = store.observeStart({ threadId, harness: 'claude', nativeAgentId: 'agent-review', description: 'Review authentication flow', role: 'reviewer', model: 'claude-sonnet-4-5' }, Date.now() - 65000);
      const child = store.observeStart({ threadId, harness: 'claude', nativeAgentId: 'agent-tests', parentNativeAgentId: 'agent-review', description: 'Inspect regression tests', role: 'test engineer' }, Date.now() - 35000);
      store.observeActivity(threadId, 'claude', 'agent-review', { kind: 'tool', text: 'Reading auth middleware', toolName: 'Read', timestamp: Date.now() - 4000 });
      store.observeActivity(threadId, 'claude', 'agent-tests', { kind: 'activity', text: 'Running targeted tests', timestamp: Date.now() - 2000 });
      manager.selectAgentRun(threadId, child.id);
      view.focusThread(threadId);
      view.renderAgentTeam();
    });
    await page.waitForSelector('.ct-agent-detail');
    await expect(page.locator('.ct-agent-tree [role="treeitem"]')).toHaveCount(2);
    await expect(page.locator('.ct-agent-team')).toHaveScreenshot('native-agent-workspace.png');
  });

  for (const viewport of [
    { name: 'iphone-14', width: 390, height: 844 },
    { name: 'iphone-se', width: 375, height: 667 },
  ]) {
    test(`native agent workspace mobile layout (${viewport.width}x${viewport.height})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(harnessUrl);
      await page.waitForSelector('.ct-title-row');
      await page.evaluate(() => {
        const view = (window as any).__view;
        const manager = view.manager;
        const threadId = 'thread-fix-auth';
        const store = manager.agentRuns;
        store.observeStart({ threadId, harness: 'claude', nativeAgentId: 'agent-review', description: 'Review authentication flow', role: 'reviewer', model: 'claude-sonnet-4-5' }, Date.now() - 65000);
        const child = store.observeStart({ threadId, harness: 'claude', nativeAgentId: 'agent-tests', parentNativeAgentId: 'agent-review', description: 'Inspect regression tests', role: 'test engineer' }, Date.now() - 35000);
        store.observeActivity(threadId, 'claude', 'agent-review', { kind: 'tool', text: 'Reading auth middleware', toolName: 'Read', timestamp: Date.now() - 4000 });
        store.observeActivity(threadId, 'claude', 'agent-tests', { kind: 'activity', text: 'Running targeted tests', timestamp: Date.now() - 2000 });
        manager.selectAgentRun(threadId, child.id);
        view.focusThread(threadId);
        view.renderAgentTeam();

        // AgentDashboard is not mounted by this harness, so render its real
        // interactive class to verify the shared mobile tap-target contract.
        const dashboardButton = document.createElement('button');
        dashboardButton.className = 'ct-dashboard-agent';
        dashboardButton.textContent = 'Test engineer';
        document.body.appendChild(dashboardButton);
      });

      await page.waitForSelector('.ct-agent-detail');
      await expect(page.locator('.ct-agent-row-button').first()).toHaveCSS('min-height', '44px');
      await expect(page.locator('.ct-dashboard-agent')).toHaveCSS('min-height', '44px');
      const hasHorizontalOverflow = await page.locator('.ct-agent-team').evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
      await expect(page.locator('.ct-agent-team')).toHaveScreenshot(`native-agent-workspace-${viewport.name}.png`);
    });
  }

  test('wikilink rendering in assistant message', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the thread whose assistant message contains [[wikilinks]]
    await page.evaluate(() => (window as any).__view.focusThread('thread-wikilinks'));
    await page.waitForTimeout(200);
    // Wikilinks should render as <a> tags, not as raw [[...]] text
    const rawBrackets = await page.locator('.ct-messages').innerText();
    if (rawBrackets.includes('[[')) {
      throw new Error('[[wikilinks]] were not rendered — raw bracket text found in message');
    }
    await expect(page).toHaveScreenshot('wikilink-rendering.png', { fullPage: true });
  });

  test('background task notice row', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the thread with persisted `notice` messages (completed + failed)
    await page.evaluate(() => (window as any).__view.focusThread('thread-notice'));
    await page.waitForSelector('.ct-notice-row');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('background-task-notice-row.png', { fullPage: true });
  });

  test('slash command autocomplete', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.click('.ct-input');
    await page.type('.ct-input', '/bra');
    await page.waitForSelector('.ct-skill-dropdown');
    await expect(page).toHaveScreenshot('slash-commands.png', { fullPage: true });
  });

  test('design artifact card actions', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => {
      const view = (window as any).__view;
      const thread = view.manager.getThread('thread-fix-auth');
      thread.artifacts = [{
        id: 'design-thread-fix-auth', kind: 'design-static', title: 'Responsive checkout concept',
        root: '/vault/.geode/artifacts/design-thread-fix-auth',
        manifestPath: '/vault/.geode/artifacts/design-thread-fix-auth/artifact.json',
        entryPath: '/vault/.geode/artifacts/design-thread-fix-auth/index.html',
        createdAt: 1, updatedAt: 1,
      }];
      view.syncEditedFiles();
    });
    await page.hover('.ct-floating-panel');
    await page.waitForSelector('.ct-artifact-card:not(.ct-hidden)');
    await expect(page).toHaveScreenshot('design-artifact-card.png', { fullPage: true });
  });

  test('permission card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Trigger the inline permission card (3-param: threadId, toolName, detail)
    page.evaluate(() => {
      (window as any).__view.manager.permissionHandler(
        'thread-fix-auth',
        'Write file',
        'src/components/TripCard.tsx',
      );
    });
    await page.waitForSelector('.ct-permission-card');
    await expect(page).toHaveScreenshot('permission-card.png', { fullPage: true });
  });

  test('permission card reappears after switching away and back', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => {
      (window as any).__view.manager.permissionHandler(
        'thread-fix-auth',
        'MCP: github',
        'Allow search_repositories?',
      );
    });
    await page.waitForSelector('.ct-permission-card');

    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await expect(page.locator('.ct-permission-card')).toHaveCount(0);

    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await expect(page.locator('.ct-permission-card')).toBeVisible();
    await expect(page.locator('.ct-permission-card')).toContainText('Allow search_repositories?');
  });

  test('MCP elicitation form card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      (window as any).__view.renderElicitationFormCard(
        {
          mode: 'form',
          serverName: 'linear',
          message: 'Choose where this issue should be created.',
          requestedSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', title: 'Project', description: 'The Linear project for this issue.' },
              priority: { type: 'string', title: 'Priority', enum: ['Low', 'Medium', 'High'] },
            },
          },
        },
        new AbortController().signal,
        () => {},
      );
    });
    await page.waitForSelector('.ct-elicitation-card');
    await expect(page).toHaveScreenshot('mcp-elicitation-form-card.png', { fullPage: true });
  });

  test('scheduled wake-up banner', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    // Schedule a wake-up 4 minutes past the pinned clock (10:00:00Z) so the
    // countdown renders deterministically as "in 4m".
    await page.evaluate(() => {
      const fireAt = new Date('2026-01-15T10:04:00Z').getTime();
      (window as any).__setWakeup('thread-fix-auth', fireAt, 'check CI status');
    });
    await page.waitForSelector('.ct-wakeup-banner:not(.ct-hidden)');
    await expect(page.locator('.ct-wakeup-banner')).toContainText('in 4m');
    await expect(page).toHaveScreenshot('wakeup-banner.png', { fullPage: true });
  });

  test('regression: wake-up banner appears automatically on run_state_settled — no thread switch needed', async ({ page }) => {
    // Reproduces the fix/scheduled-wakeup-visibility bug end to end through the
    // real ThreadManager -> ThreadsView.handleEvent -> refreshWakeupBanner
    // pipeline (not a direct render() call): a thread whose session moved into
    // ThreadManager's `lingeringSessions` before 'done' fired used to leave the
    // banner stuck hidden forever, because isRunning() was still true at that
    // instant and nothing re-checked it once the session actually settled.
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      const w = window as any;
      const threadId = 'thread-fix-auth';
      const fireAt = new Date('2026-01-15T10:04:00Z').getTime();
      // The thread is mid-turn (isRunning() true) when the wake-up is registered.
      w.__setThreadRunning(threadId, true);
      w.__setWakeup(threadId, fireAt, 'check CI status');
    });
    // Banner must stay hidden — isRunning() is still true.
    await expect(page.locator('.ct-wakeup-banner')).toHaveClass(/ct-hidden/);

    await page.evaluate(() => (window as any).__setThreadRunning('thread-fix-auth', false));
    // isRunning() just went false, but no event fired yet — the banner must
    // NOT flip on its own; only an explicit event triggers a re-check.
    await expect(page.locator('.ct-wakeup-banner')).toHaveClass(/ct-hidden/);

    await page.evaluate(() => (window as any).__fireRunStateSettled('thread-fix-auth'));
    // This is the fix under test: the banner appears from the event alone,
    // with no focusThread()/thread-switch call anywhere in this test.
    await page.waitForSelector('.ct-wakeup-banner:not(.ct-hidden)');
    await expect(page.locator('.ct-wakeup-banner')).toContainText('in 4m');
  });

  test('active loop banner and footer pill', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    // Seed a loop targeting the active thread — mirrors what /loop 5m ... does.
    await page.evaluate(() => {
      (window as any).__setLoop('thread-fix-auth', 'check the build', 300);
      (window as any).__view.renderThreadInfo();
    });
    await page.waitForSelector('.ct-loop-banner:not(.ct-hidden)');
    await expect(page.locator('.ct-loop-banner')).toContainText('Looping every 5m');
    await expect(page.locator('.ct-loop-banner-stop')).toBeVisible();
    await expect(page.locator('.ct-footer-pill')).toContainText('Looping every 5m');
    await expect(page).toHaveScreenshot('loop-banner.png', { fullPage: true });
  });

  test('scheduled origin footer pill', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    // Seed the thread's origin metadata the same way Scheduler.createThread
    // does when a cron item fires and creates a new thread.
    await page.evaluate(() => {
      (window as any).__setScheduledOrigin('thread-fix-auth', 'sched-1', 'Nightly build check');
      (window as any).__view.renderThreadInfo();
    });
    await page.waitForSelector('.ct-footer-pill');
    await expect(page.locator('.ct-footer-pill')).toContainText('Scheduled: Nightly build check');
    await expect(page).toHaveScreenshot('scheduled-origin-pill.png', { fullPage: true });
  });

  test('fork conversation menu item', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open the more menu
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await expect(page).toHaveScreenshot('fork-menu.png', { fullPage: true });
  });

  test('model switcher menu', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open the footer model switcher (cpu icon, left of the more button)
    await page.click('.ct-model-btn');
    await page.waitForSelector('.menu');
    // Move mouse away so no menu item is in hover state
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('model-switcher-menu.png', { fullPage: true });
  });

  // Modal IS mocked in obsidian-mock.ts and renders .modal-container into document.body on open()
  test('fork conversation modal', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open the more menu and click Fork
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.getByText('Fork conversation').click();
    await page.waitForSelector('.modal-container');
    await expect(page).toHaveScreenshot('fork-modal-initial.png', { fullPage: true });
  });

  // Modal IS mocked in obsidian-mock.ts and renders .modal-container into document.body on open()
  test('fork conversation modal after generation', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open fork modal
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.getByText('Fork conversation').click();
    await page.waitForSelector('.modal-container');
    // Click generate
    await page.getByText('Generate fork prompt').click();
    // Wait for the textarea to appear (mock resolves instantly)
    await page.waitForSelector('.ct-fork-textarea', { state: 'visible' });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('fork-modal-review.png', { fullPage: true });
  });

  test('edited files card with focus button', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    // Thread 1 (Fix auth middleware) has editedFiles seeded — wait for the card
    await page.waitForSelector('.ct-edited-files:not(.ct-hidden)');
    await page.waitForTimeout(500);
    // Hover to reveal the focus button (opacity: 0 normally, 1 on hover)
    await page.hover('.ct-edited-files');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('edited-files-focus.png', { fullPage: true });
  });

  // ─── 0.3.0 feature tests ─────────────────────────────────────────────────────

  test('@ file mention autocomplete', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);

    // Patch the vault mock so getMarkdownFiles returns fake file objects.
    // The harness vault mock does not define getMarkdownFiles, so we add it here.
    await page.evaluate(() => {
      const view = (window as any).__view;
      view.app.vault.getMarkdownFiles = () => [
        { path: 'Projects/HipTrip.md', basename: 'HipTrip' },
        { path: 'Daily/2026-05-16.md', basename: '2026-05-16' },
        { path: 'Claude/repo-map.md', basename: 'repo-map' },
      ];
    });

    await page.click('.ct-input');
    await page.type('.ct-input', '@hip');
    await page.waitForSelector('.ct-file-dropdown');
    await expect(page).toHaveScreenshot('file-mention.png', { fullPage: true });
  });

  test('context recap banner', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);

    // Trigger the banner directly — bypasses the idle-threshold guard that
    // prevents it from showing when the user was "just here".
    // Thread at index 1 is thread-brainstorm; pass its summary or a fallback string.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const thread = view.manager.getThreads()[1];
      view['showSummaryBanner'](
        thread,
        thread.summary || 'Brainstormed social features for HipTrip, explored gamification and collaborative trip planning options.',
      );
    });

    await page.waitForSelector('.ct-summary-banner');
    await expect(page).toHaveScreenshot('context-recap-banner.png', { fullPage: true });
  });

  // Agent Dashboard is not instantiated or exposed in the test harness (index.ts only
  // mounts ThreadsView). To un-skip: add AgentDashboard to the harness, expose it as
  // window.__dashboard, and wire up a permissionHandler call against a dashboard thread.
  test.skip('agent dashboard permission buttons — AgentDashboard not mounted in harness; add it to test/harness/index.ts and expose as window.__dashboard to un-skip', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(500);

    // Trigger a permission request on thread 1
    await page.evaluate(() => {
      (window as any).__view.manager.permissionHandler(
        'thread-fix-auth',
        'Write file',
        'src/components/TripCard.tsx',
      );
    });

    // Switch to the Agent Dashboard view
    await page.evaluate(() => {
      (window as any).__dashboard?.onOpen?.();
    });

    await page.waitForSelector('.ct-agents-permission-actions');
    await expect(page).toHaveScreenshot('dashboard-permission-buttons.png', { fullPage: true });
  });

  // Wake lock status bar is wired up in main.ts (WakeLockService + Obsidian status bar API).
  // Neither the real plugin lifecycle nor addStatusBarItem() is available in the harness.
  // Verify manually in Obsidian: enable Settings > Keep computer awake, start a response,
  // and confirm the "Keeping awake" item appears in the Obsidian status bar.
  test.skip('wake lock status bar — harness does not wire up the real plugin WakeLockService or Obsidian status bar; verify manually in Obsidian by enabling Settings -> Keep computer awake and starting a response', async ({ page }) => {});

  // ─── Compress view ──────────────────────────────────────────────────────────

  test('compress view menu item', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the agentic thread (has consecutive assistant messages)
    await page.evaluate(() => (window as any).__view.focusThread('thread-agentic'));
    await page.waitForTimeout(200);
    // Open the more menu — "Compress view" should be the first item
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    // Move mouse away so no menu item is in hover state
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('compress-view-menu.png', { fullPage: true });
  });

  test('compressed messages', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the agentic thread (has consecutive assistant messages for grouping)
    await page.evaluate(() => (window as any).__view.focusThread('thread-agentic'));
    await page.waitForTimeout(200);
    // Toggle compress view via the more menu
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.getByText('Compress view').click();
    // Wait for the compressed layout to render (3 consecutive assistant msgs → grouped block)
    await page.waitForSelector('.ct-message-compressed');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('compress-view-active.png', { fullPage: true });
  });

  test('compressed message expand', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the agentic thread
    await page.evaluate(() => (window as any).__view.focusThread('thread-agentic'));
    await page.waitForTimeout(200);
    // Activate compress view
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.getByText('Compress view').click();
    await page.waitForSelector('.ct-message-compressed');
    await page.waitForTimeout(200);
    // Expand the first (and only) compressed group
    await page.click('.ct-expand-btn');
    await page.waitForSelector('.ct-full-content:not(.ct-hidden)');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('compress-view-expanded.png', { fullPage: true });
  });

  test('streaming tool pills above panel', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);

    // Simulate a running thread: create the streaming element and inject tool pills
    // directly so we can test the visual state without needing a live Claude process.
    await page.evaluate(() => {
      const view = (window as any).__view;

      // Create the streaming bubble (private method accessible via bracket notation)
      view['createStreamingEl']();

      // Inject 4 tool pills — same DOM structure the real code produces
      const tools = [
        { name: 'Read',   summary: 'src/middleware/auth.ts' },
        { name: 'Read',   summary: '.env.example' },
        { name: 'Bash',   summary: 'npm test -- --testPathPattern=auth' },
        { name: 'Write',  summary: 'src/middleware/__tests__/auth.test.ts' },
      ];

      for (const tool of [...tools].reverse()) {
        const pill = document.createElement('div');
        pill.className = 'ct-tool-pill ct-tool-active';

        const icon = document.createElement('span');
        icon.className = 'ct-tool-pill-icon';
        icon.textContent = '📄';

        const badge = document.createElement('span');
        badge.className = 'ct-tool-pill-name';
        badge.textContent = tool.name;

        const label = document.createElement('span');
        label.className = 'ct-tool-pill-text';
        label.textContent = tool.summary;

        pill.append(icon, badge, label);
        view['streamingEl'].prepend(pill);
      }

      // Scroll to bottom (triggers the rAF + clearance update)
      view['scrollToBottom']();
    });

    // Wait for rAF + any ResizeObserver callbacks to settle
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('streaming-tool-pills.png', { fullPage: true });
  });

  test('tool result images rendered inline in assistant message', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Thread 1 is the default; scroll to bottom to see the image message
    await page.evaluate(() => (window as any).__view['scrollToBottom']());
    await page.waitForTimeout(200);
    // The fixture has a message with toolResultImages — verify the img is in the DOM
    const imgCount = await page.locator('.ct-tool-result-images img').count();
    if (imgCount === 0) throw new Error('No .ct-tool-result-images img found — toolResultImages not rendered');
    await expect(page).toHaveScreenshot('tool-result-images.png', { fullPage: true });
  });

  // ─── Skills Manager ──────────────────────────────────────────────────────

  test('skills manager — installed tab', async ({ page }) => {
    const skillsUrl = 'file://' + path.resolve('test/harness/skills.html');
    await page.setViewportSize({ width: 640, height: 700 });
    await page.goto(skillsUrl);
    await page.waitForSelector('.ct-skills-count');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('skills-manager-installed.png', { fullPage: true });
  });

  test('skills manager — browse tab', async ({ page }) => {
    const skillsUrl = 'file://' + path.resolve('test/harness/skills.html');
    await page.setViewportSize({ width: 640, height: 700 });
    await page.goto(skillsUrl);
    await page.waitForSelector('.ct-skills-tabs');
    await page.getByText('Browse').click();
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('skills-manager-browse.png', { fullPage: true });
  });

  // ─── Settings tab ────────────────────────────────────────────────────────

  test('settings — general tab', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-tabs');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('settings-general.png', { fullPage: true });
  });

  test('settings — claude tab', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-tabs');
    // The tab whose id is 'claude' is now labelled "Agent" (harness-agnostic
    // naming since the Codex harness landed); the screenshot keeps the historical
    // settings-claude.png name to match the tab id.
    await page.click('.ct-settings-tab-btn:has-text("Agent")');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('settings-claude.png', { fullPage: true });
  });

  test('settings — tools tab', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-tabs');
    await page.click('.ct-settings-tab-btn:has-text("Tools")');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('settings-tools.png', { fullPage: true });
  });

  test('settings — mcp tab', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-tabs');
    await page.click('.ct-settings-tab-btn:has-text("MCP")');
    await page.waitForTimeout(200);
    // Collapse the fixed-height harness shell to the content so the docs
    // screenshot (copied out by posttest:screenshots:update) crops tight
    // instead of trailing a large empty panel below the server list.
    await page.evaluate(() => {
      const app = document.getElementById('app');
      if (app) app.style.height = 'auto';
    });
    await page.waitForTimeout(50);
    await expect(page).toHaveScreenshot('settings-mcp.png', { fullPage: true });
  });

  test('settings — mcp edit server form', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-tabs');
    await page.click('.ct-settings-tab-btn:has-text("MCP")');
    await page.waitForTimeout(200);
    // Open the edit modal on the first (stdio) server so the form shows real
    // values, including an ${ENV_VAR} placeholder in the environment field.
    await page
      .locator('.ct-mcp-servers-list .setting-item')
      .first()
      .getByRole('button', { name: 'Edit' })
      .click();
    await page.waitForSelector('.modal-overlay');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('settings-mcp-edit.png', { fullPage: true });
  });

  test('sub-agent task pill while working', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Thread 1 is the default; scroll to bottom to see the image message
    await page.evaluate(() => (window as any).__view['scrollToBottom']());
    await page.waitForTimeout(200);
    // The fixture has a message with toolResultImages — verify the img is in the DOM
    const imgCount = await page.locator('.ct-tool-result-images img').count();
    if (imgCount === 0) throw new Error('No .ct-tool-result-images img found — toolResultImages not rendered');
    await expect(page).toHaveScreenshot('tool-result-images.png', { fullPage: true });

    // Simulate the state after an Agent tool call commits: the "Sub-agent working"
    // placeholder is created, then task_started prepends a task pill to it.
    await page.evaluate(() => {
      const view = (window as any).__view;

      // Create the streaming element with the sub-agent label
      view['createStreamingEl']('Sub-agent working');

      // Simulate a task pill (same structure as task_started handler produces)
      const pill = document.createElement('div');
      pill.className = 'ct-tool-pill ct-tool-active ct-task-pill';

      const iconEl = document.createElement('span');
      iconEl.className = 'ct-tool-pill-icon';
      // Use text icon as a stand-in (Obsidian setIcon unavailable in harness)
      iconEl.textContent = '🤖';

      const badge = document.createElement('span');
      badge.className = 'ct-tool-pill-name';
      badge.textContent = 'sub-agent';

      const label = document.createElement('span');
      label.className = 'ct-tool-pill-text';
      label.textContent = 'Implementing the auth middleware · Read (1m12s)';

      pill.append(iconEl, badge, label);
      view['streamingEl'].prepend(pill);
      view['scrollToBottom']();
    });

    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('subagent-task-pill.png', { fullPage: true });
  });

  test('workflow progress block while running', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);

    // Simulate the workflow block DOM that task_started (local_workflow) produces,
    // followed by two sub-agent rows (one running, one done).
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['createStreamingEl']('Sub-agent working');

      const block = document.createElement('div');
      block.className = 'ct-workflow-block';

      // Header
      const header = document.createElement('div');
      header.className = 'ct-workflow-header';
      const iconEl = document.createElement('span');
      iconEl.className = 'ct-workflow-icon';
      iconEl.textContent = '⑂';
      const nameEl = document.createElement('span');
      nameEl.className = 'ct-workflow-name';
      nameEl.textContent = 'review-changes';
      const phaseEl = document.createElement('span');
      phaseEl.className = 'ct-workflow-phase';
      phaseEl.textContent = ' · Review';
      header.append(iconEl, nameEl, phaseEl);

      // Agent list
      const agentList = document.createElement('div');
      agentList.className = 'ct-workflow-agents';

      // Running agent
      const row1 = document.createElement('div');
      row1.className = 'ct-workflow-agent-row ct-workflow-agent-running';
      const dot1 = document.createElement('span');
      dot1.className = 'ct-workflow-agent-dot';
      dot1.textContent = '●';
      const desc1 = document.createElement('span');
      desc1.className = 'ct-workflow-agent-desc';
      desc1.textContent = 'Review for bugs · Bash (4s)';
      row1.append(dot1, desc1);

      // Done agent
      const row2 = document.createElement('div');
      row2.className = 'ct-workflow-agent-row ct-workflow-agent-done';
      const dot2 = document.createElement('span');
      dot2.className = 'ct-workflow-agent-dot';
      dot2.textContent = '✔';
      const desc2 = document.createElement('span');
      desc2.className = 'ct-workflow-agent-desc';
      desc2.textContent = 'No security issues found';
      row2.append(dot2, desc2);

      agentList.append(row1, row2);
      block.append(header, agentList);
      view['streamingEl'].appendChild(block);
      view['scrollToBottom']();
    });

    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('workflow-block-running.png', { fullPage: true });

    // Simulate workflow completion
    await page.evaluate(() => {
      const block = document.querySelector('.ct-workflow-block');
      if (block) {
        block.classList.add('ct-workflow-done');
        const phase = block.querySelector('.ct-workflow-phase');
        if (phase) phase.textContent = ' · Done';
      }
    });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('workflow-block-done.png', { fullPage: true });
  });

  test('task list card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => (window as any).__view.focusThread('thread-tasks'));
    await page.waitForSelector('.ct-task-card:not(.ct-hidden)');
    // Hover the panel so the task card is expanded (it collapses at rest via CSS)
    await page.hover('.ct-floating-panel');
    await page.waitForTimeout(300); // let expand animation complete
    const header = await page.locator('.ct-task-card-header').innerText();
    if (!header.includes('5 tasks') || !header.includes('4 done, 1 in progress, 0 open')) {
      throw new Error(`Unexpected task card header: ${header}`);
    }
    await expect(page.locator('.ct-task-row-completed')).toHaveCount(4);
    await expect(page.locator('.ct-task-row-in_progress')).toHaveCount(1);
    await expect(page).toHaveScreenshot('task-list-card.png', { fullPage: true });

    // Collapse on header click
    await page.click('.ct-task-card-header');
    await expect(page.locator('.ct-task-row')).toHaveCount(0);
  });

  test('status line — structured tag pills', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);
    // Drive the footer the same way StatusLineService would: store status tags
    // on the active thread (dev url, branch, PR with url, AWS warn tone).
    await page.evaluate(() => {
      (window as any).__manager.applyStatusTags('thread-brainstorm', [
        { label: 'http://localhost:3001', url: 'http://localhost:3001', kind: 'dev' },
        { label: 'feat/social-nudge', kind: 'branch' },
        { label: 'PR #225', url: 'https://github.com/acme/hip-trip/pull/225', kind: 'pr' },
        { label: 'AWS expired', tone: 'warn', kind: 'aws' },
      ]);
    });
    await page.waitForSelector('.ct-footer-pill-pr');
    // Four pills, in order, with the PR pill rendered.
    await expect(page.locator('.ct-footer-pill')).toHaveCount(4);
    await expect(page.locator('.ct-footer-pill-warn')).toHaveCount(1);
    await expect(page).toHaveScreenshot('status-line-tags.png', { fullPage: true });
  });

  test('git diff bar — branch, diff stat, and Create PR split button', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);
    // Drive the bar the same way GitDiffService would: store git diff info on
    // the active thread (feature branch, base branch, a real diff, GitHub origin).
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'feat/social-nudge',
        baseBranch: 'main',
        insertions: 60,
        deletions: 4,
        ownerRepo: { owner: 'acme', repo: 'hip-trip' },
      });
    });
    await page.waitForSelector('.ct-git-diff-bar:not(.ct-hidden)');
    await expect(page.locator('.ct-git-diff-branch-name')).toHaveText('feat/social-nudge');
    await expect(page.locator('.ct-git-diff-repo')).toHaveText('hip-trip');
    await expect(page.locator('.ct-git-diff-stat-add')).toHaveText('+60');
    await expect(page.locator('.ct-git-diff-stat-del')).toHaveText('-4');
    await expect(page.locator('.ct-git-diff-create-btn')).toHaveText('Create PR');
    await expect(page).toHaveScreenshot('git-diff-bar.png', { fullPage: true });

    // Open the split-button dropdown: 3 actions.
    await page.click('.ct-git-diff-dropdown-btn');
    await page.waitForSelector('.menu');
    const menuItems = await page.locator('.menu .menu-item').allTextContents();
    expect(menuItems).toEqual(['Create PR', 'Create draft PR', 'Manually create PR']);
    await expect(page).toHaveScreenshot('git-diff-bar-menu.png', { fullPage: true });
  });

  test('git diff bar — View PR when the thread already has an open PR', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);
    // Drive both the diff bar and the sticky prUrl the same way GitDiffService
    // and the status-line PR tag would: a real diff, plus an existing open PR.
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'feat/social-nudge',
        baseBranch: 'main',
        insertions: 60,
        deletions: 4,
        ownerRepo: { owner: 'acme', repo: 'hip-trip' },
      });
      (window as any).__manager.applyStatusTags('thread-brainstorm', [
        { label: 'PR #225', url: 'https://github.com/acme/hip-trip/pull/225', kind: 'pr' },
      ]);
    });
    await page.waitForSelector('.ct-git-diff-bar:not(.ct-hidden)');
    await expect(page.locator('.ct-git-diff-create-btn')).toHaveText('View PR');
    await expect(page).toHaveScreenshot('git-diff-bar-view-pr.png', { fullPage: true });

    // Open the split-button dropdown: View PR is prepended above the other 3 actions.
    await page.click('.ct-git-diff-dropdown-btn');
    await page.waitForSelector('.menu');
    const menuItems = await page.locator('.menu .menu-item').allTextContents();
    expect(menuItems).toEqual(['View PR', 'Create PR', 'Create draft PR', 'Manually create PR']);
  });

  test('git diff bar — hidden for a non-git thread and for the base branch', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);

    // Not a git repo at all — bar stays hidden.
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', { isGitRepo: false });
    });
    await page.waitForTimeout(50);
    await expect(page.locator('.ct-git-diff-bar')).toHaveClass(/ct-hidden/);

    // Sitting on the base branch itself — nothing to PR against, bar stays hidden.
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'main',
        baseBranch: 'main',
        isBaseBranch: true,
      });
    });
    await page.waitForTimeout(50);
    await expect(page.locator('.ct-git-diff-bar')).toHaveClass(/ct-hidden/);
  });

  // ── Kanban board ──────────────────────────────────────────────────────────
  // Served from a dedicated harness (test/harness/kanban.html) that mounts
  // KanbanView against kanbanFixtureThreads. The wider 1180px board needs its
  // own viewport, separate from the 420px conversation-view tests above.

  const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');

  test('kanban board — group by status', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');
    // Status mode is the default — assert the seven status columns are present.
    // (CSS text-transform uppercases the labels, so compare case-insensitively.)
    const labels = (await page.locator('.ct-kanban-col-label').allInnerTexts()).map(s => s.toUpperCase());
    for (const expected of ['Working', 'Awaiting', 'Waiting', 'New', 'Done', 'Failed', 'Ready']) {
      if (!labels.includes(expected.toUpperCase())) {
        throw new Error(`Status board missing the "${expected}" column. Got: ${labels.join(', ')}`);
      }
    }
    // The seeded waiting-thread card shows the hourglass icon and countdown text.
    // (Scoped to the accent class, not text — "Awaiting" contains "waiting" as
    // a substring so a text filter would match the wrong column.)
    const waitingCol = page.locator('.ct-kanban-col-waiting');
    await expect(waitingCol.locator('.ct-kanban-icon-waiting')).toHaveCount(1);
    await expect(waitingCol).toContainText('Resumes');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('kanban-status.png', { fullPage: true });
  });

  test('kanban kickoff harness picker selects without dispatching', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');

    const harnessButton = page.locator('.ct-kanban-dispatch .ct-harness-send-btn');
    await expect(harnessButton).toHaveAttribute('aria-label', /Claude/);
    await harnessButton.click({ button: 'right' });

    const menu = page.locator('.ct-harness-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Codex' })).toHaveCSS('min-height', '44px');

    await menu.getByRole('menuitemradio', { name: 'Codex' }).click();
    await expect(menu).toHaveCount(0);
    await expect(harnessButton).toHaveAttribute('aria-label', /Codex/);
    expect(await page.evaluate(() => (window as any).__dispatchCalls.length)).toBe(0);

    await harnessButton.click({ button: 'right' });
    const reopenedMenu = page.locator('.ct-harness-menu');
    await expect(reopenedMenu).toBeVisible();
    await expect(reopenedMenu).toHaveScreenshot('kanban-harness-picker.png');
  });

  test('kanban board — group by folder swimlanes', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');
    await page.evaluate(() => (window as any).__setGroupBy('folder'));
    await page.waitForSelector('.ct-kanban-swimlanes');
    // One lane per app/project, alphabetical (case-insensitive) with Unassigned last.
    const lanes = await page.locator('.ct-kanban-lane-name').allInnerTexts();
    const expected = ['acme-api', 'Claude Threads', 'HipTrip', 'Unassigned'];
    if (JSON.stringify(lanes) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected swimlane order. Expected ${expected.join(', ')} — got ${lanes.join(', ')}`);
    }
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('kanban-folder-swimlanes.png', { fullPage: true });
  });

  test('kanban board — group by project columns', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');
    await page.evaluate(() => (window as any).__setGroupBy('project'));
    await page.waitForSelector('.ct-kanban-project-col');

    // One vertical column per app/project — same alphabetical (case-insensitive),
    // Unassigned-last ordering as folder swimlanes (both share sortGroupEntries()).
    // (CSS text-transform uppercases .ct-kanban-col-label, same as the status board —
    // compare case-insensitively, same pattern as the "group by status" test above.)
    const columns = (await page.locator('.ct-kanban-project-col .ct-kanban-col-label').allInnerTexts()).map(s => s.toUpperCase());
    const expected = ['acme-api', 'Claude Threads', 'HipTrip', 'Unassigned'].map(s => s.toUpperCase());
    if (JSON.stringify(columns) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected project column order. Expected ${expected.join(', ')} — got ${columns.join(', ')}`);
    }

    // HipTrip: threads are grouped under sidebar-style status SECTIONS, not the
    // status board's 7 columns — there is never a separate Awaiting section
    // anywhere on this board (it always folds into Working; see the
    // "awaiting folds into Working" unit tests in kanban-project-columns.test.ts
    // for the bucketing logic itself — the harness's seeded running/awaiting
    // threads don't actually flip ThreadManager.isRunning() true, so this
    // screenshot test sticks to what's reliably observable: Waiting/New/Reviewed).
    const hiptripCol = page.locator('.ct-kanban-project-col').filter({
      has: page.locator('.ct-kanban-col-label', { hasText: 'HipTrip' }),
    });
    const hiptripSections = (await hiptripCol.locator('.ct-kanban-project-section-name').allInnerTexts()).map(s => s.toUpperCase());
    for (const expectedLabel of ['Waiting', 'New', 'Reviewed']) {
      if (!hiptripSections.includes(expectedLabel.toUpperCase())) {
        throw new Error(`HipTrip column missing the "${expectedLabel}" section. Got: ${hiptripSections.join(', ')}`);
      }
    }
    if (hiptripSections.includes('AWAITING')) {
      throw new Error('Project-columns mode must fold Awaiting into Working, not render a separate Awaiting section');
    }

    // Claude Threads surfaces a non-default section (Failed).
    const threadsCol = page.locator('.ct-kanban-project-col').filter({
      has: page.locator('.ct-kanban-col-label', { hasText: 'Claude Threads' }),
    });
    await expect(threadsCol.locator('.ct-kanban-project-section-name', { hasText: 'Failed' })).toHaveCount(1);

    // New section carries a badge with its thread count.
    const hiptripNewLabel = hiptripCol.locator('.ct-kanban-project-section-label').filter({
      has: page.locator('.ct-kanban-project-section-name', { hasText: 'New' }),
    });
    await expect(hiptripNewLabel.locator('.ct-kanban-badge')).toHaveCount(1);

    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('kanban-project-columns.png', { fullPage: true });
  });

  test('regression: kanban card moves Working → Waiting automatically on run_state_settled', async ({ page }) => {
    // Same root-cause bug as the wake-up banner test above, on the dashboard
    // side: KanbanView.handleEvent's isStateChange didn't include
    // wakeup_changed/run_state_settled, so a thread that finished with a
    // pending wake-up stayed bucketed under "Working" until an unrelated
    // event forced a re-render.
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');

    const cardTitle = 'Add "why this place" provenance layer'; // kanbanRunningThreadId's card
    const workingCard = page.locator('.ct-kanban-col', { hasText: 'Working' }).getByText(cardTitle);
    await expect(workingCard).toBeVisible();

    await page.evaluate(() => {
      const w = window as any;
      const threadId = 'k-hiptrip-running'; // kanbanRunningThreadId
      const fireAt = new Date('2026-01-15T10:04:00Z').getTime();
      w.__addWakeup(threadId, fireAt, 'check CI status');
    });
    // Still running (seeded running at harness load) — must stay in Working.
    await expect(workingCard).toBeVisible();

    await page.evaluate(() => (window as any).__setThreadRunning('k-hiptrip-running', false));
    // isRunning() just went false, but no event fired — must NOT move yet.
    await expect(workingCard).toBeVisible();

    await page.evaluate(() => (window as any).__fireRunStateSettled('k-hiptrip-running'));
    // This is the fix under test: the card re-buckets into Waiting from the
    // event alone — no manual render() call, no group-by toggle, no reload.
    const waitingCard = page.locator('.ct-kanban-col-waiting').getByText(cardTitle);
    await expect(waitingCard).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.ct-kanban-col', { hasText: 'Working' }).getByText(cardTitle)).toHaveCount(0);
  });

  test('kanban board — orchestrator badge on matching card', async ({ page }) => {
    // appendOrchestratorBadge only fires when a card's threadId matches
    // settings.orchestratorThreadId — confirm the bot badge appears next to
    // that one card's title and no other card's.
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');

    const cardTitle = 'Add "why this place" provenance layer'; // kanbanRunningThreadId's card
    await expect(page.locator('.ct-orchestrator-badge')).toHaveCount(0);

    await page.evaluate(() => (window as any).__setOrchestrator('k-hiptrip-running'));
    const badgedCard = page.locator('.ct-kanban-card', { hasText: cardTitle });
    await expect(badgedCard.locator('.ct-orchestrator-badge')).toHaveCount(1);
    await expect(page.locator('.ct-orchestrator-badge')).toHaveCount(1);
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('kanban-orchestrator-badge.png', { fullPage: true });
  });

  // ─── Status area redesign ─────────────────────────────────────────────────

  test('queue rows — stacked removable rows above composer', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Inject 3 queued messages into the active thread via manager internals
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const threadId = view['activeThreadId'];
      if (!threadId) throw new Error('No active thread');
      // Set running state so the queue accumulates (not auto-sent)
      manager['isRunningMap'] = manager['isRunningMap'] ?? new Map();
      manager['runningThreads'] = manager['runningThreads'] ?? new Set();
      manager['runningThreads'].add(threadId);
      // Push 3 items into the private queue map
      const queue = [
        { text: 'Quick reply about the deploy status, is it green yet?' },
        { text: 'Need help with the rate limit logs from last night' },
        { text: 'Can you draft an email to Lindsey about the timeline change?' },
      ];
      manager['queuedMessages'].set(threadId, queue);
      // Fire a queued event so the view re-renders
      view['renderQueueRows']();
    });
    await page.waitForSelector('.ct-queue-row');
    await expect(page).toHaveScreenshot('queue-rows.png', { fullPage: true });
  });

  test('status rail — active-work card with spinner', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Show a "Compacting context…" active-work card in the rail
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['showStatusCard']('active', 'Compacting context…');
    });
    await page.waitForSelector('.ct-status-card-active');
    await expect(page).toHaveScreenshot('status-rail-active-card.png', { fullPage: true });
  });

  test('thinking spinner — shown before first token', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Trigger the streaming placeholder (thinking spinner) via private method
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['createStreamingEl']();
      view['scrollToBottom']();
    });
    await page.waitForSelector('.ct-thinking-spinner');
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('thinking-spinner.png', { fullPage: true });
  });

  test('model escalation tip — popover above model button', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['showModelEscalationTip']('⚡ Using claude-sonnet-4-5 for this turn');
    });
    await page.waitForSelector('.ct-escalation-tip');
    // Playwright freezes CSS animations at frame 0 (opacity: 0). Override to show
    // the tip at full opacity for the snapshot.
    await page.addStyleTag({ content: '.ct-escalation-tip { animation: none !important; opacity: 1 !important; transform: translateX(-50%) !important; }' });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('model-escalation-tip.png', { fullPage: true });
  });

  test('model escalation — button stays highlighted for the whole turn', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Drive the real event path: ThreadManager emits 'escalated' at turn start.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const manager = (window as any).__manager;
      manager['emit'](view['activeThreadId'], { type: 'escalated', model: 'opus' });
    });
    await page.waitForSelector('.ct-model-btn.ct-model-btn-escalated');
    // Hide the transient tip and freeze the pulse so the snapshot is deterministic.
    await page.addStyleTag({
      content:
        '.ct-escalation-tip { display: none !important; } .ct-model-btn-escalated { animation: none !important; }',
    });
    await page.waitForTimeout(100);
    await expect(page).toHaveScreenshot('model-escalation-turn-button.png', { fullPage: true });
    // Turn end clears the indicator.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const manager = (window as any).__manager;
      manager['emit'](view['activeThreadId'], { type: 'done' });
    });
    await expect(page.locator('.ct-model-btn')).not.toHaveClass(/ct-model-btn-escalated/);
  });

  // ─── SDK alignment gap features (Group 4 + 5) ────────────────────────────

  test('plan mode — planning state card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Trigger the "Planning..." status card the same way the enter_plan_mode event does.
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['createStreamingEl']();
      view['showStatusCard']('active', 'Planning...');
      view['scrollToBottom']();
    });
    await page.waitForSelector('.ct-status-card-active');
    await expect(page.locator('.ct-status-card-active')).toContainText('Planning...');
    await expect(page).toHaveScreenshot('plan-mode-planning.png', { fullPage: true });
  });

  test('plan mode — approve/reject card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Render the plan approval card with sample plan text.
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['createStreamingEl']();
      const planText = [
        '## Plan: Fix the auth middleware',
        '',
        '**Step 1:** Read src/middleware/auth.ts to understand the current implementation.',
        '**Step 2:** Identify the JWT_SECRET fallback bug.',
        '**Step 3:** Fix the empty-string fallback — throw on startup instead.',
        '**Step 4:** Add a test covering the missing-secret case.',
        '**Step 5:** Verify tsc and tests pass.',
      ].join('\n');
      // approve/reject are no-ops for the screenshot
      view['renderPlanCard'](planText, () => {}, () => {});
      view['scrollToBottom']();
    });
    await page.waitForSelector('.ct-plan-card');
    // Wait for async markdown rendering to finish
    await page.waitForSelector('.ct-plan-md', { state: 'visible' });
    await page.waitForTimeout(200);
    await expect(page.locator('.ct-plan-card')).toBeVisible();
    await expect(page.locator('.ct-plan-approve')).toBeVisible();
    await expect(page.locator('.ct-plan-edit')).toBeVisible();
    await expect(page.locator('.ct-plan-reject')).toBeVisible();
    // Default view should show rendered markdown, not a textarea
    await expect(page.locator('.ct-plan-md')).toBeVisible();
    await expect(page.locator('.ct-plan-textarea')).not.toBeVisible();
    await expect(page).toHaveScreenshot('plan-mode-approve-reject.png', { fullPage: true });
  });

  test('context usage panel', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Render the context usage card with a representative usage snapshot.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const fakeUsage = {
        totalTokens: 42850,
        maxTokens: 200000,
        percentage: 21.4,
        categories: [
          { name: 'System prompt', tokens: 3200, color: '#4b9cd3' },
          { name: 'Tools', tokens: 8400, color: '#7cb9e8' },
          { name: 'Messages', tokens: 28050, color: '#97c1e8' },
          { name: 'MCP tools', tokens: 3200, color: '#b0cfe8' },
        ],
        agents: [],
      };
      view['renderContextUsageCard'](fakeUsage);
      view['scrollToBottom']();
    });
    await page.waitForSelector('.ct-context-usage-card');
    await expect(page.locator('.ct-context-usage-card')).toBeVisible();
    await expect(page.locator('.ct-context-usage-title')).toContainText('Context usage');
    await expect(page).toHaveScreenshot('context-usage-panel.png', { fullPage: true });
  });

  for (const usageViewport of [
    { name: 'desktop', width: 1280, height: 800, golden: 'usage-panel-desktop.png' },
    { name: 'mobile', width: 390, height: 844, golden: 'usage-panel-mobile.png' },
    { name: 'mobile SE', width: 375, height: 667, golden: 'usage-panel-mobile-se.png' },
  ]) {
    test(`usage panel — ${usageViewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: usageViewport.width, height: usageViewport.height });
      await page.goto(harnessUrl);
      await page.waitForSelector('.ct-messages');
      await page.evaluate(() => {
        const view = (window as any).__view;
        view['renderUsageCard']({
          provider: 'codex', updatedAt: new Date('2026-08-17T14:00:00-04:00').getTime(),
          tokens: { total: 42000, input: 35000, cachedInput: 12000, output: 7000, reasoning: 2000 },
          lastTurnTokens: { total: 2400 },
          quotaWindows: [
            { label: '5 hours', usedPercent: 84, resetsAt: new Date('2026-08-17T15:00:00-04:00').getTime() },
            { label: '7 days', usedPercent: 100, resetsAt: new Date('2026-08-24T14:00:00-04:00').getTime() },
          ],
          accountUsage: {
            lifetimeTokens: 125000, peakDailyTokens: 18000, longestRunningTurnSeconds: 95,
            currentStreakDays: 4, longestStreakDays: 11,
            daily: [{ date: '2026-08-17', tokens: 4200 }, { date: '2026-08-16', tokens: 3800 }],
          },
        });
      });

      const card = page.locator('.ct-usage-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('42,000 thread/session tokens');
      await expect(card.locator('.ct-usage-quota')).toHaveCount(2);
      await expect(card.locator('.ct-usage-bar-warning')).toHaveCount(1);
      await expect(card.locator('.ct-usage-bar-exhausted')).toHaveCount(1);
      await expect(card).toContainText('125,000 lifetime tokens');
      await expect(card).toContainText('4 day current streak');
      await expect(card).toContainText('Aug 17, 2026');
      await expect(card.locator('.ct-usage-account')).toHaveCount(0);
      expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await expect(page).toHaveScreenshot(usageViewport.golden, { fullPage: true });
    });
  }

});

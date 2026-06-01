import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

test.describe('Claude Threads UI', () => {
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

  test('fork conversation menu item', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open the more menu
    await page.click('.ct-more-btn');
    await page.waitForSelector('.menu');
    await expect(page).toHaveScreenshot('fork-menu.png', { fullPage: true });
  });

  // Modal IS mocked in obsidian-mock.ts and renders .modal-container into document.body on open()
  test('fork conversation modal', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open the more menu and click Fork
    await page.click('.ct-more-btn');
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
    await page.click('.ct-more-btn');
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
    await page.click('.ct-more-btn');
    await page.waitForSelector('.menu');
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
    await page.click('.ct-more-btn');
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
    await page.click('.ct-more-btn');
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
});

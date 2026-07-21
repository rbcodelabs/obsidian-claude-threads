import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * Mobile visual regression tests.
 *
 * Coverage matrix — every UI state and every element we touch in mobile sprints
 * should have a snapshot here.
 *
 * Full-page snapshots:
 *   mobile-pairing          — disconnected state (pairing instructions)
 *   mobile-connected        — conversation panel, streaming in progress (iPhone 14, 390px)
 *   mobile-thread-list      — thread list panel, no active thread  (iPhone 14, 390px)
 *   mobile-thread-list-se   — thread list at iPhone SE width (320px) — catches overflow regressions
 *   mobile-connected-ipad   — conversation panel at iPad width (820px)
 *
 * Element-level snapshots (clipped — catch small button/layout changes that are
 * invisible against a full 390×844 canvas):
 *   mobile-input-toolbar       — .ct-mobile-input-row: send, attach, stop buttons + textarea
 *   mobile-permission-card     — .ct-mobile-permission-card: deny/allow/always-allow buttons
 *   mobile-question-card       — .ct-mobile-question-card: single-select + multiSelect questions, Other, Submit
 *   mobile-queue-rows          — .ct-mobile-queue-rows: stacked queue rows above composer
 *   mobile-status-rail-active  — .ct-mobile-status-rail: compacting status card
 *   mobile-error-card          — .ct-mobile-error-card: error display with dismiss
 *   mobile-thread-list-search  — thread list filtered by search query
 */

const mobileHarnessUrl = (view: string, opts?: { width?: number; height?: number }) => {
  const base = 'file://' + path.resolve('test/harness/mobile.html');
  const params = new URLSearchParams({ view });
  if (opts?.width) params.set('width', String(opts.width));
  if (opts?.height) params.set('height', String(opts.height));
  return `${base}?${params.toString()}`;
};

test.describe('Mobile View', () => {
  // Pin Date.now()/new Date() to the fixture epoch (test/harness/fixtures.ts)
  // so relative labels ("Last active …") are deterministic — without this,
  // baselines with "Xd ago" text drift every day the suite is run.
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  // ── Full-page snapshots ────────────────────────────────────────────────────

  test('mobile pairing screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-pairing'));
    await page.waitForSelector('.ct-mobile-pairing');
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('mobile-pairing.png', { fullPage: true });
  });

  test('mobile connected view (conversation panel)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('mobile-connected.png', { fullPage: true });
  });

  test('mobile thread list (iPhone 14 — 390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-thread-list'));
    await page.waitForSelector('.ct-mobile-thread-list');
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('mobile-thread-list.png', { fullPage: true });
  });

  test('mobile thread list (iPhone SE — 320px)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(mobileHarnessUrl('mobile-thread-list', { width: 320, height: 568 }));
    await page.waitForSelector('.ct-mobile-thread-list');
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('mobile-thread-list-se.png', { fullPage: true });
  });

  test('mobile connected view (iPad — 820px)', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(mobileHarnessUrl('mobile-connected', { width: 820, height: 1180 }));
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('mobile-connected-ipad.png', { fullPage: true });
  });

  // ── Element-level snapshots ────────────────────────────────────────────────
  // These clip to specific components so a 10px change on a 34px button doesn't
  // vanish against the noise of an 844px full-page canvas.

  test('input toolbar (send, attach, stop buttons + textarea)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-input-row');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-mobile-input-row')).toHaveScreenshot('mobile-input-toolbar.png');
  });

  test('input toolbar focused (accent border ring)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-input');
    await page.locator('.ct-mobile-input').focus();
    await page.waitForTimeout(200);
    await expect(page.locator('.ct-mobile-input-row')).toHaveScreenshot('mobile-input-toolbar-focused.png');
  });

  test('permission card (deny / allow buttons — 44px tap targets)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-permission'));
    await page.waitForSelector('.ct-mobile-permission-card');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-mobile-permission-card')).toHaveScreenshot('mobile-permission-card.png');
  });

  test('question card (single-select + multiSelect, Other, 44px tap targets)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-question'));
    await page.waitForSelector('.ct-mobile-question-card');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-mobile-question-card')).toHaveScreenshot('mobile-question-card.png');
  });

  test('queue rows (stacked above composer, replace flat banner)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-queue'));
    // Phase 3: flat .ct-mobile-queue-banner replaced by .ct-mobile-queue-rows with individual rows
    await page.waitForSelector('.ct-mobile-queue-rows');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-mobile-queue-rows')).toHaveScreenshot('mobile-queue-rows.png');
  });

  // ── Phase 3 element-level snapshots ───────────────────────────────────────

  test('status rail — compacting card', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    // Wait for conv panel — status rail exists but is hidden until a status frame arrives
    await page.waitForSelector('.ct-mobile-conv-panel');
    await page.waitForTimeout(300);
    // Inject a status frame to trigger the compacting card
    await page.evaluate(() => {
      (window as any).__store.applyFrame({ type: 'status', threadId: 'thread-fix-auth', status: 'compacting' });
    });
    // Wait for the card to appear inside the rail
    await page.waitForSelector('.ct-status-card');
    await page.waitForTimeout(200);
    await expect(page.locator('.ct-mobile-status-rail')).toHaveScreenshot('mobile-status-rail-active.png');
  });

  test('error card — lastError with dismiss button', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-thread-list'));
    await page.waitForSelector('.ct-mobile-thread-list');
    // Inject an errored thread as active
    await page.evaluate(() => {
      (window as any).__store.applyFrame({
        type: 'snapshot',
        threads: [{
          id: 'err-snap', title: 'Error thread', cwd: '/projects/test',
          messages: [{ id: 'm1', role: 'user', content: 'Do something', timestamp: 1000 }],
          lastError: 'WebSocket closed (1006) — connection lost',
          createdAt: 0, updatedAt: 1000,
        }],
        activeThreadId: 'err-snap',
      });
    });
    await page.waitForSelector('.ct-mobile-error-card');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-mobile-error-card')).toHaveScreenshot('mobile-error-card.png');
  });

  test('thread list — search filtered results', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-thread-list'));
    await page.waitForSelector('.ct-mobile-search-input');
    await page.locator('.ct-mobile-search-input').fill('auth');
    await page.waitForTimeout(250); // debounce
    await expect(page.locator('.ct-mobile-list-panel')).toHaveScreenshot('mobile-thread-list-search.png');
  });
});

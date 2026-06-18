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
 *   mobile-input-toolbar    — .ct-mobile-input-row: send, attach, stop buttons + textarea
 *   mobile-permission-card  — .ct-mobile-permission-card: deny/allow buttons (44px tap targets)
 */

const mobileHarnessUrl = (view: string, opts?: { width?: number; height?: number }) => {
  const base = 'file://' + path.resolve('test/harness/mobile.html');
  const params = new URLSearchParams({ view });
  if (opts?.width) params.set('width', String(opts.width));
  if (opts?.height) params.set('height', String(opts.height));
  return `${base}?${params.toString()}`;
};

test.describe('Mobile View', () => {
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

  test('queue banner with cancel button', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-queue'));
    await page.waitForSelector('.ct-mobile-queue-banner');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-mobile-queue-banner')).toHaveScreenshot('mobile-queue-banner.png');
  });
});

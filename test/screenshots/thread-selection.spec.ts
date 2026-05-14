import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

/**
 * Regression tests for the "dispatch from Agent Dashboard doesn't select the new thread" bug.
 *
 * The harness fixture loads three threads sorted by createdAt ascending:
 *   thread-new         (T3 = 2 h ago)  ← oldest — was incorrectly selected before the fix
 *   thread-brainstorm  (T2 = 45 m ago)
 *   thread-fix-auth    (T1 = 5 m ago)  ← newest — should be selected after the fix
 */

test.describe('ThreadsView — initial thread selection', () => {
  test('defaults to the most recently created thread on open, not the oldest', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-tab-bar');
    await page.waitForSelector('.ct-messages');

    const activeId: string = await page.evaluate(() => (window as any).__view.getActiveThreadId());

    // After the fix: should be the newest thread
    expect(activeId).toBe('thread-fix-auth');

    // Regression guard: the OLD buggy default was threads[0] = oldest thread
    expect(activeId).not.toBe('thread-new');
  });

  test('active tab in the UI matches the most recently created thread', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-tab-bar');
    await page.waitForTimeout(200);

    // The active tab element should contain the title of the newest thread
    const activeTab = page.locator('.ct-tab.ct-tab-active');
    await expect(activeTab).toContainText('Fix auth middleware');
  });

  test('focusThread switches to the targeted thread', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-tab-bar');

    // Simulate focusThread being called (e.g. from openThreadInChatView)
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));

    const activeId: string = await page.evaluate(() => (window as any).__view.getActiveThreadId());
    expect(activeId).toBe('thread-brainstorm');

    const activeTab = page.locator('.ct-tab.ct-tab-active');
    await expect(activeTab).toContainText('HipTrip feature');
  });
});

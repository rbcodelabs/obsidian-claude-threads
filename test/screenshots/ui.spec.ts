import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

test.describe('Claude Threads UI', () => {
  test('main view', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-tab-bar');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the HipTrip thread which shows a markdown table
    await page.getByText('HipTrip feature id').click();
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('main-view.png', { fullPage: true });
  });

  test('slash command autocomplete', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-tab-bar');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.click('.ct-input');
    await page.type('.ct-input', '/bra');
    await page.waitForSelector('.ct-skill-dropdown');
    await expect(page).toHaveScreenshot('slash-commands.png', { fullPage: true });
  });

  test('permission modal', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-tab-bar');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Trigger the permission modal without awaiting (it's a promise that resolves on user action)
    page.evaluate(() => {
      (window as any).__manager.permissionHandler(
        'Write file',
        'src/components/TripCard.tsx',
      );
    });
    await page.waitForSelector('.modal-container');
    await expect(page).toHaveScreenshot('permission-modal.png', { fullPage: true });
  });
});

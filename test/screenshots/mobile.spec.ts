import { test, expect } from '@playwright/test';
import path from 'path';

const mobileHarnessUrl = (view: string) =>
  'file://' + path.resolve('test/harness/mobile.html') + `?view=${view}`;

test.describe('Mobile View', () => {
  test('mobile pairing screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-pairing'));
    await page.waitForSelector('.ct-mobile-pairing');
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('mobile-pairing.png', { fullPage: true });
  });

  test('mobile connected view', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mobileHarnessUrl('mobile-connected'));
    await page.waitForSelector('.ct-mobile-thread-list');
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('mobile-connected.png', { fullPage: true });
  });
});

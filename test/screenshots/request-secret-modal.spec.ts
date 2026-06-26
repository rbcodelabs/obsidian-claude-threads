import { test, expect } from '@playwright/test';
import path from 'path';

const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');

test.describe('RequestSecretModal', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 760 });
    await page.goto(settingsUrl);
    // Wait for the settings tab to mount
    await page.waitForSelector('.vertical-tab-content');
  });

  test('normal mode — "requesting" heading, no replacement note', async ({ page }) => {
    // Open modal without force — don't await; the Promise resolves only when the user saves/cancels
    page.evaluate(() => void (window as any).__openRequestSecretModal(false));
    await page.waitForSelector('.modal-overlay');
    await page.waitForTimeout(100);

    // The mock Modal has an empty titleEl h2 followed by contentEl; use role + name to be precise
    await expect(page.getByRole('heading', { name: 'Agent is requesting a secret' })).toBeVisible();

    // Replacement note must NOT be present
    const noteVisible = await page.locator('.modal-container .setting-item-description').evaluateAll(
      (els) => els.some((el) => el.textContent?.includes('existing value for this secret will be replaced')),
    );
    expect(noteVisible).toBe(false);

    await expect(page).toHaveScreenshot('request-secret-modal-normal.png');
  });

  test('force mode — "replacing" heading and replacement note', async ({ page }) => {
    // Open modal with force=true
    page.evaluate(() => void (window as any).__openRequestSecretModal(true));
    await page.waitForSelector('.modal-overlay');
    await page.waitForTimeout(100);

    // Verify correct heading text
    await expect(page.getByRole('heading', { name: 'Agent is replacing a secret' })).toBeVisible();

    // Replacement note MUST be present
    const noteVisible = await page.locator('.modal-container .setting-item-description').evaluateAll(
      (els) => els.some((el) => el.textContent?.includes('existing value for this secret will be replaced')),
    );
    expect(noteVisible).toBe(true);

    await expect(page).toHaveScreenshot('request-secret-modal-force.png');
  });
});

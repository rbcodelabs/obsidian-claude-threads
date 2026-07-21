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

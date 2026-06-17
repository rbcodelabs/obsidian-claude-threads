import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

/**
 * Screenshot tests for bridge-aware edits (PR #219).
 *
 * The harness app mock has no vault-bridges plugin, so each test installs a
 * mock bridge API at runtime (mirroring the file-mention test's pattern of
 * patching the vault mock). This keeps the fixtures untouched and avoids
 * churning unrelated snapshot baselines.
 *
 * Mock bridge: repo /Users/mock/projects/hip-trip, sourcePath docs/,
 * mirrored into vault folder "Projects/HipTrip Docs".
 */

async function installBridgeMocks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const view = (window as any).__view;
    const bridge = {
      id: 'bridge-hiptrip-docs',
      name: 'HipTrip Docs',
      repoPath: '/Users/mock/projects/hip-trip',
      sourcePath: 'docs',
      vaultPath: 'Projects/HipTrip Docs',
      branch: 'main',
      autoSync: true,
      status: 'idle',
    };
    // getVaultBridgesAPI reads app.plugins.plugins['vault-bridges'].api
    view.app.plugins = {
      plugins: {
        'vault-bridges': {
          api: {
            getBridges: () => [bridge],
            syncBridge: async () => {},
          },
        },
      },
    };
    // Linkification and chip mapping only activate when the synced vault copy
    // exists — make files under the bridge's vaultPath "exist".
    view.app.vault.getAbstractFileByPath = (p: string) =>
      p.startsWith('Projects/HipTrip Docs/') ? { path: p } : null;
  });
}

test.describe('Bridge-aware edits', () => {
  test('edited-file chip for a bridge-repo file sorts first with vault tooltip', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-edited-files:not(.ct-hidden)');

    await installBridgeMocks(page);
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const thread = manager.getThread('thread-fix-auth');
      // A repo edit under the bridge's source folder, alongside the two
      // existing non-bridge repo edits seeded by the fixture.
      thread.editedFiles = [
        ...(thread.editedFiles ?? []),
        '/Users/mock/projects/hip-trip/docs/setup.md',
      ];
      // Round-trip the thread switch to rebuild the edited-files card with
      // the bridge mocks in place.
      view.focusThread('thread-brainstorm');
      view.focusThread('thread-fix-auth');
    });
    await page.waitForTimeout(300);

    // Bridge-mapped file counts as a vault file: sorts before the two
    // non-vault repo files and its tooltip shows the vault-relative path.
    const chips = page.locator(
      '.ct-edited-file-chip:not(.ct-focus-files-chip):not(.ct-edited-files-cwd)'
    );
    await expect(chips).toHaveCount(3);
    await expect(chips.first()).toHaveAttribute('aria-label', 'Projects/HipTrip Docs/setup.md');
    await expect(chips.first()).toContainText('setup.md');
    // Non-bridge repo files keep their absolute-path tooltip.
    await expect(chips.nth(1)).toHaveAttribute(
      'aria-label',
      '/Users/mock/projects/hip-trip/src/middleware/__tests__/auth.test.ts'
    );

    // Remove the collapsible class so all context-zone items are always visible
    // regardless of hover/focus state — this test checks chip ordering, not
    // collapse behaviour, and CSS pseudo-class rendering varies under parallel load.
    await page.evaluate(() => {
      document.querySelector('.ct-floating-panel')?.classList.remove('ct-panel-collapsible');
    });
    await expect(page).toHaveScreenshot('edited-files-bridge.png', { fullPage: true });
  });

  test('absolute bridge-repo path in message text becomes an internal link', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');

    await installBridgeMocks(page);
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const thread = manager.getThread('thread-brainstorm');
      // Fixed timestamp (never Date.now()) so baselines are stable.
      const ts = new Date('2026-01-15T09:20:00Z').getTime();
      thread.messages.push({
        id: 'msg-bridge-link',
        role: 'assistant',
        content:
          'I updated the setup guide at /Users/mock/projects/hip-trip/docs/setup.md ' +
          'and the draft at `/Users/mock/projects/hip-trip/docs/drafts/outline.md`. ' +
          'The scratch file /Users/mock/projects/hip-trip/notes.txt is outside the ' +
          'bridged folder so it stays plain text.',
        timestamp: ts,
      });
      // Switch to the thread so its messages render with the mocks in place.
      view.focusThread('thread-brainstorm');
    });
    await page.waitForTimeout(300);

    // Paths under the bridge source folder (plain text AND inline code) are
    // linkified to the synced vault copy.
    const link = page.locator('a.internal-link[data-href="Projects/HipTrip Docs/setup.md"]');
    await expect(link).toBeVisible();
    await expect(
      page.locator('a.internal-link[data-href="Projects/HipTrip Docs/drafts/outline.md"]')
    ).toBeVisible();
    // A repo path outside the bridged source folder is NOT linkified.
    await expect(page.locator('a.internal-link', { hasText: 'notes.txt' })).toHaveCount(0);

    await expect(page).toHaveScreenshot('message-bridge-link.png', { fullPage: true });
  });
});

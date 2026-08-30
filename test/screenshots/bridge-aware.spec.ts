import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { anchorFocusedComposerToBottom, settleView, shot } from './helpers';

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
  // Pin Date.now()/new Date() to the fixture epoch (test/harness/fixtures.ts)
  // so relative labels ("Last active …") are deterministic — without this,
  // baselines with "Xd ago" text drift every day the suite is run.
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  test('edited-file chip for a bridge-repo file sorts first with vault tooltip', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-edited-files:not(.ct-hidden)');

    await installBridgeMocks(page);
    await page.evaluate(async () => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const thread = manager.getThread('thread-fix-auth');
      // A repo edit under the bridge's source folder, alongside the two
      // existing non-bridge repo edits seeded by the fixture.
      thread.editedFiles = [
        ...(thread.editedFiles ?? []),
        '/Users/mock/projects/hip-trip/docs/setup.md',
      ];
      // Switch away, then back, waiting for each shared-view transition to
      // finish before starting the next one.
      await view.setActiveThread('thread-brainstorm');
      await view.setActiveThread('thread-fix-auth');
    });
    await anchorFocusedComposerToBottom(page);

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

    // Let late message/image layout finish before forcing this chip-ordering
    // scene open. Expanding first lets later content reflow retain a stale
    // message viewport and can clip the in-flow composer during comparison.
    await settleView(page);
    await page.evaluate(async () => {
      document.querySelector('.ct-floating-panel')?.classList.remove('ct-panel-collapsible');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const messages = document.querySelector<HTMLElement>('.ct-messages');
      if (messages) messages.scrollTop = messages.scrollHeight;
    });
    await expect(chips.first()).toBeVisible();
    // The bridge card and composer are part of the state this regression
    // captures; expanding the panel must not leave it below the viewport.
    await expect(page.locator('.ct-floating-panel')).toBeInViewport({ ratio: 1 });
    await shot(page, 'edited-files-bridge.png', { fullPage: true });
  });

  test('absolute bridge-repo path in message text becomes an internal link', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');

    await installBridgeMocks(page);
    await page.evaluate(async () => {
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
      await view.focusThread('thread-brainstorm');
    });
    await anchorFocusedComposerToBottom(page);

    // Paths under the bridge source folder (plain text AND inline code) are
    // linkified to the synced vault copy.
    const link = page.locator('a.internal-link[data-href="Projects/HipTrip Docs/setup.md"]');
    await expect(link).toBeVisible();
    await expect(
      page.locator('a.internal-link[data-href="Projects/HipTrip Docs/drafts/outline.md"]')
    ).toBeVisible();
    // A repo path outside the bridged source folder is NOT linkified.
    await expect(page.locator('a.internal-link', { hasText: 'notes.txt' })).toHaveCount(0);

    // The canonical visualization fixture mounts an iframe during initial
    // harness load before this test switches threads. Its late layout work can
    // race ThreadsView's scheduled scrollToBottom() and leave this conversation
    // at one of several otherwise-stable offsets. Settle that work, then pin the
    // message scroller to the intended bottom position before comparing pixels.
    await settleView(page);
    await page.evaluate(async () => {
      const messages = document.querySelector<HTMLElement>('.ct-messages');
      if (messages) messages.scrollTop = messages.scrollHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await expect(link).toBeVisible();
    await expect(
      page.locator('a.internal-link[data-href="Projects/HipTrip Docs/drafts/outline.md"]')
    ).toBeVisible();
    await shot(page, 'message-bridge-link.png', { fullPage: true });
  });
});

/**
 * Playwright tests for the inline AskUserQuestion card.
 *
 * Covers the path where a thread has a persisted pendingQuestions (from a
 * session that died before the user could answer) and restorePendingQuestionCard()
 * re-renders it on focus — the question-card counterpart to
 * plan-mode-restore.spec.ts.
 */
import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

const SAMPLE_QUESTIONS = [
  {
    question: 'Which approach should I take?',
    header: 'Implementation approach',
    options: [
      { label: 'Rewrite the module', description: 'Cleaner, but touches more files.' },
      { label: 'Patch in place', description: 'Faster, smaller diff.' },
    ],
    multiSelect: false,
  },
];

test.describe('AskUserQuestion — inline card (pendingQuestions)', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  test('question card renders when thread has pendingQuestions and no active session', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    // Pre-seed the active thread with pendingQuestions (simulates a persisted
    // question set from a session that was killed before the user answered).
    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      // Re-focus the thread to trigger restorePendingQuestionCard()
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');
    await page.waitForTimeout(200);

    await expect(page.locator('.ct-question-card')).toBeVisible();
    await expect(page.locator('.ct-question-card-submit')).toBeVisible();
    await expect(page.locator('.ct-question-header')).toHaveText('Implementation approach');
    await expect(page.locator('.ct-question-option')).toHaveCount(2);

    await expect(page).toHaveScreenshot('question-card-restored.png', { fullPage: true });
  });

  test('submit sends formatted answers and clears pendingQuestions', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      (window as any).__sendMessageCalls = [];
      manager.sendMessage = async (threadId: string, text: string) => {
        (window as any).__sendMessageCalls.push({ threadId, text });
      };
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');

    // Pick the first radio option, then submit.
    await page.locator('.ct-question-option input[type="radio"]').first().click();
    await page.locator('.ct-question-card-submit').click();

    // Card should be gone
    await expect(page.locator('.ct-question-card')).not.toBeAttached();

    const calls = await page.evaluate(() => (window as any).__sendMessageCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('Which approach should I take?');
    expect(calls[0].text).toContain('Rewrite the module');

    const pendingQuestions = await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const thread = manager.getThread(view['activeThreadId']);
      return thread.pendingQuestions;
    });
    expect(pendingQuestions).toBeUndefined();
  });

  test('no card rendered when thread has no pendingQuestions', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const view = (window as any).__view;
      view.focusThread(view['activeThreadId']);
    });

    await page.waitForTimeout(200);
    await expect(page.locator('.ct-question-card')).not.toBeAttached();
  });

  test('no duplicate card when a live resolver is already registered for the backgrounded thread', async ({ page }) => {
    // Simulates AskUserQuestion firing while the user was viewing a different
    // thread: ThreadsView's questionHandler already populated its in-memory
    // pendingQuestions map AND registered a live resolver with ThreadManager
    // (mirroring what happens for a real inactive-thread question) before the
    // user ever focuses the thread. restorePendingQuestionCard() must defer to
    // the renderMessages() tail re-render in this case instead of rendering
    // its own second card.
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      const resolver = () => {};
      manager.registerQuestionResolver(activeId, resolver);
      view['pendingQuestions'].set(activeId, { questions, resolve: resolver, cardEl: null });
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');
    await page.waitForTimeout(200);

    await expect(page.locator('.ct-question-card')).toHaveCount(1);
  });

  test('no duplicate card when focusThread is called twice', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(300);

    await page.evaluate((questions) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'];
      const thread = manager.getThread(activeId);
      thread.pendingQuestions = questions;
      manager.sendMessage = async () => {};
      view.focusThread(activeId);
      view.focusThread(activeId);
    }, SAMPLE_QUESTIONS);

    await page.waitForSelector('.ct-question-card');
    await page.waitForTimeout(200);

    await expect(page.locator('.ct-question-card')).toHaveCount(1);
  });
});

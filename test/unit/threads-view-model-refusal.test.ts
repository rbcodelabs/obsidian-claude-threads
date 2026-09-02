/**
 * @vitest-environment jsdom
 */
import '../setup/obsidian-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({
  formatToolName: (name: string) => name,
  getToolIcon: () => 'wrench',
}));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class {} }));
vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => false }));
vi.mock('../../src/SkillsManagerView', () => ({ ConfirmModal: class {} }));

import { Notice } from 'obsidian';
import { ThreadsView } from '../../src/ThreadsView';
import type { ThreadEvent } from '../../src/ThreadManager';

function handle(event: ThreadEvent): void {
  const view = new ThreadsView({} as never, { manager: {} } as never) as unknown as {
    handleEvent: (event: ThreadEvent) => void;
  };
  view.handleEvent(event);
}

describe('ThreadsView model refusal Notices', () => {
  beforeEach(() => {
    Notice.messages.length = 0;
  });

  it('prefers SDK content for fallback and no-fallback refusal events', () => {
    handle({
      type: 'model_refusal_fallback', content: 'Retried safely.', originalModel: 'opus',
      fallbackModel: 'sonnet', scope: 'session',
    });
    handle({
      type: 'model_refusal_no_fallback', content: 'Could not answer.', originalModel: 'opus',
    });

    expect(Notice.messages).toEqual([
      { message: 'Retried safely.', duration: 5000 },
      { message: 'Could not answer.', duration: 5000 },
    ]);
  });

  it('uses defensive fallback text when SDK content is empty', () => {
    handle({
      type: 'model_refusal_fallback', content: '', originalModel: 'opus',
      fallbackModel: 'sonnet', scope: 'local',
    });
    handle({
      type: 'model_refusal_no_fallback', content: '', originalModel: 'opus',
    });

    expect(Notice.messages).toEqual([
      { message: 'Claude retried with sonnet.', duration: 5000 },
      { message: 'Claude opus could not answer this request.', duration: 5000 },
    ]);
  });
});

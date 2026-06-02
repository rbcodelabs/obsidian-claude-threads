/**
 * DispatchInput.test.ts
 * @vitest-environment jsdom
 *
 * Regression guard for the PTT wiring bug (PR #126 dropped, PR #136 restored):
 * when `getPttKey` is provided to DispatchInput, mount() must call
 * attachPttToTextarea() on the SttController instance. If that call is ever
 * dropped again, this test will fail immediately.
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom

// vi.mock calls must be hoisted above the imports they affect.
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock fs so DispatchInput.loadSkills() doesn't try to read the real filesystem.
vi.mock('fs', () => ({
  default: {
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => false }),
    existsSync: () => false,
    readFileSync: () => '',
  },
  readdirSync: () => [],
  statSync: () => ({ isDirectory: () => false }),
  existsSync: () => false,
  readFileSync: () => '',
}));

// Mock SttController so we can spy on attachPttToTextarea without needing a
// real browser microphone or MediaRecorder. createMicButton must return a
// real HTMLButtonElement so DispatchInput can insert it into the DOM.
//
// The factory keeps a module-level `lastInstance` reference that each test
// reads after calling mount(). Using a proper `function` constructor ensures
// `new SttController()` works correctly.
vi.mock('../../src/stt', () => {
  let lastInstance: MockSttInstance | null = null;

  interface MockSttInstance {
    attachPttToTextarea: ReturnType<typeof vi.fn>;
    createMicButton: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }

  function SttController() {
    lastInstance = {
      attachPttToTextarea: vi.fn(() => () => {}),
      createMicButton: vi.fn(() => document.createElement('button')),
      destroy: vi.fn(),
    };
    return lastInstance;
  }

  // Expose a getter so tests can read the most-recently-created instance.
  (SttController as unknown as { getLastInstance: () => MockSttInstance | null }).getLastInstance =
    () => lastInstance;

  return { SttController };
});

import { DispatchInput } from '../../src/DispatchInput';
import { SttController } from '../../src/stt';
import { App } from 'obsidian';

// Type helper: the mock factory attaches getLastInstance() to SttController.
type MockSttConstructor = typeof SttController & {
  getLastInstance: () => {
    attachPttToTextarea: ReturnType<typeof vi.fn>;
    createMicButton: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  } | null;
};

const MockSttController = SttController as unknown as MockSttConstructor;

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeApp(): App {
  return new App();
}

function makeContainer(): HTMLElement {
  return document.createElement('div');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DispatchInput — PTT wiring', () => {
  it('calls attachPttToTextarea when getPttKey is provided', () => {
    const getPttKey = () => 'ctrl+shift+space';
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      getPttKey,
    });

    di.mount(makeContainer());

    const stt = MockSttController.getLastInstance()!;
    expect(stt.attachPttToTextarea).toHaveBeenCalledOnce();
    // First arg must be the textarea, second must be the exact getter passed in.
    const [textarea, keyGetter] = stt.attachPttToTextarea.mock.calls[0];
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(keyGetter).toBe(getPttKey);
  });

  it('does NOT call attachPttToTextarea when getPttKey is omitted', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      // no getPttKey — mic button still created, PTT not wired
    });

    di.mount(makeContainer());

    const stt = MockSttController.getLastInstance()!;
    expect(stt.attachPttToTextarea).not.toHaveBeenCalled();
  });

  it('still creates a mic button regardless of getPttKey', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
    });

    di.mount(makeContainer());

    const stt = MockSttController.getLastInstance()!;
    expect(stt.createMicButton).toHaveBeenCalledOnce();
  });
});

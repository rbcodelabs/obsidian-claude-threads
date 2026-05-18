/**
 * MobileView.test.ts
 * @vitest-environment jsdom
 *
 * DOM-level tests for MobileView. Tests the core UI logic without a real Obsidian
 * runtime:
 *
 *   - Panel switching (showPanel): the exact mechanism that was broken and caused
 *     "tap thread → nothing happens"
 *   - Thread list renders titles + previews
 *   - Thread tap immediately switches panel (doesn't wait for store notify)
 *   - scrollToBottom uses requestAnimationFrame (not synchronous)
 *   - Send button dispatches correct command
 *   - Pairing screen shown when relayClient/store are null
 *   - Disconnected banner appears/disappears on connection state changes
 *   - create_thread command includes required title field
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileView, MOBILE_VIEW_TYPE } from '../../src/MobileView';
import { MobileThreadStore } from '../../src/MobileThreadStore';
import type { SerializedThread, SerializedMessage } from '../../src/relay-protocol';

// Obsidian is aliased to test/__mocks__/obsidian.ts in vitest.config.ts.
// marked is mocked below so markdown parsing resolves synchronously in tests.
vi.mock('marked', () => ({
  marked: {
    parse: (content: string) => Promise.resolve(`<p>${content}</p>`),
  },
}));

// ── RelayClient mock ───────────────────────────────────────────────────────

type MockCommand = { type: string; [key: string]: unknown };

function makeRelayClient() {
  const sentCommands: MockCommand[] = [];
  const connectionListeners: Array<(state: string) => void> = [];

  return {
    sentCommands,
    connectionListeners,
    sendCommand: vi.fn((cmd: MockCommand) => { sentCommands.push(cmd); }),
    onConnectionStateChange: vi.fn((listener: (state: string) => void) => {
      connectionListeners.push(listener);
      return () => {};
    }),
    triggerConnectionState(state: string) {
      connectionListeners.forEach((l) => l(state));
    },
  };
}

// ── Thread factory ─────────────────────────────────────────────────────────

function makeThread(overrides: Partial<SerializedThread> = {}): SerializedThread {
  return {
    id: 'thread-1',
    title: 'My Thread',
    cwd: '/cwd',
    messages: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Hello there',
    timestamp: 1000,
    ...overrides,
  };
}

// ── MobileView harness ─────────────────────────────────────────────────────

interface ViewHarness {
  view: MobileView;
  store: MobileThreadStore;
  relay: ReturnType<typeof makeRelayClient>;
}

async function buildView(opts?: { noRelay?: boolean }): Promise<ViewHarness> {
  const store = new MobileThreadStore();
  const relay = makeRelayClient();

  const mockLeaf = {} as never;
  const view = new MobileView(
    mockLeaf,
    opts?.noRelay ? null : (relay as never),
    opts?.noRelay ? null : store,
  );

  await view.onOpen();
  return { view, store, relay };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MobileView — getViewType', () => {
  it('returns the correct view type', async () => {
    const { view } = await buildView();
    expect(view.getViewType()).toBe(MOBILE_VIEW_TYPE);
    await view.onClose();
  });

  it('returns correct display text', async () => {
    const { view } = await buildView();
    expect(view.getDisplayText()).toBe('Claude Threads (Mobile)');
    await view.onClose();
  });
});

describe('MobileView — panel switching', () => {
  it('starts on list panel (no threads)', async () => {
    const { view, store } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    const root = (view as never)['rootEl'] as HTMLElement;
    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    const convPanel = (view as never)['convPanelEl'] as HTMLElement;

    expect(listPanel.style.display).not.toBe('none');
    expect(convPanel.style.display).toBe('none');

    await view.onClose();
  });

  it('switches to conversation panel when showPanel("conversation") is called', async () => {
    const { view } = await buildView();

    const showPanel = (view as never)['showPanel'].bind(view) as (p: string) => void;
    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    const convPanel = (view as never)['convPanelEl'] as HTMLElement;

    showPanel('conversation');

    expect(listPanel.style.display).toBe('none');
    expect(convPanel.style.display).toBe('flex');

    await view.onClose();
  });

  it('switches back to list panel when showPanel("list") is called', async () => {
    const { view } = await buildView();

    const showPanel = (view as never)['showPanel'].bind(view) as (p: string) => void;
    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    const convPanel = (view as never)['convPanelEl'] as HTMLElement;

    showPanel('conversation');
    showPanel('list');

    expect(convPanel.style.display).toBe('none');
    expect(listPanel.style.display).toBe('flex');

    await view.onClose();
  });

  it('switches to conversation panel when active thread is set', async () => {
    const { view, store } = await buildView();
    const thread = makeThread({ id: 'tid', title: 'Test' });

    store.applyFrame({ type: 'snapshot', threads: [thread], activeThreadId: 'tid' });

    const convPanel = (view as never)['convPanelEl'] as HTMLElement;
    // After snapshot with an active thread, view should auto-switch to conversation
    expect(convPanel.style.display).toBe('flex');

    await view.onClose();
  });
});

describe('MobileView — thread list rendering', () => {
  it('renders each thread as a list item', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({ id: 'a', title: 'Alpha' }),
        makeThread({ id: 'b', title: 'Beta', createdAt: 2000 }),
      ],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    const items = threadList.querySelectorAll('.ct-mobile-thread-item');
    expect(items).toHaveLength(2);

    await view.onClose();
  });

  it('shows thread title in each list item', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'a', title: 'Alpha thread' })],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.textContent).toContain('Alpha thread');

    await view.onClose();
  });

  it('shows message preview for thread with messages', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'a',
          title: 'With messages',
          messages: [makeMessage({ content: 'Preview text here' })],
        }),
      ],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.textContent).toContain('Preview text here');

    await view.onClose();
  });

  it('shows empty state when no threads', async () => {
    const { view, store } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.querySelector('.ct-mobile-no-threads')).not.toBeNull();

    await view.onClose();
  });
});

describe('MobileView — thread tap panel switch', () => {
  it('switching panel immediately (before store notify) when thread is tapped', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'Tap me' })],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    const item = threadList.querySelector('.ct-mobile-thread-item') as HTMLElement;
    expect(item).not.toBeNull();

    const convPanel = (view as never)['convPanelEl'] as HTMLElement;
    expect(convPanel.style.display).toBe('none'); // starts hidden

    item.click();

    // Panel switch should happen IMMEDIATELY, not waiting for store notify
    expect(convPanel.style.display).toBe('flex');

    await view.onClose();
  });

  it('updates conversation title when thread is tapped', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'My Special Thread' })],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    const item = threadList.querySelector('.ct-mobile-thread-item') as HTMLElement;
    item.click();

    const convTitle = (view as never)['convTitleEl'] as HTMLSpanElement;
    expect(convTitle.textContent).toBe('My Special Thread');

    await view.onClose();
  });

  it('sends set_active_thread command when thread is tapped', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: null,
    });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    (threadList.querySelector('.ct-mobile-thread-item') as HTMLElement).click();

    expect(relay.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_active_thread', threadId: 'tid' }),
    );

    await view.onClose();
  });
});

describe('MobileView — back button', () => {
  it('pressing back returns to list panel', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    // Auto-switched to conversation because active thread is set
    const convPanel = (view as never)['convPanelEl'] as HTMLElement;
    expect(convPanel.style.display).toBe('flex');

    const backBtn = convPanel.querySelector('.ct-mobile-back-btn') as HTMLElement;
    backBtn.click();

    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    expect(listPanel.style.display).toBe('flex');
    expect(convPanel.style.display).toBe('none');

    await view.onClose();
  });
});

describe('MobileView — send message', () => {
  it('send button dispatches send_message command with correct threadId', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'active-tid', title: 'Chat' })],
      activeThreadId: 'active-tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    const sendBtn = (view as never)['sendBtn'] as HTMLButtonElement;

    inputEl.value = 'Hello from mobile';
    sendBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'send_message',
      threadId: 'active-tid',
      text: 'Hello from mobile',
    });

    await view.onClose();
  });

  it('clears input after send', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    const sendBtn = (view as never)['sendBtn'] as HTMLButtonElement;

    inputEl.value = 'Some message';
    sendBtn.click();

    expect(inputEl.value).toBe('');

    await view.onClose();
  });

  it('does not send empty message', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    const sendBtn = (view as never)['sendBtn'] as HTMLButtonElement;

    inputEl.value = '   '; // whitespace only
    sendBtn.click();

    expect(relay.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_message' }),
    );

    await view.onClose();
  });

  it('Enter key sends message', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    inputEl.value = 'Enter send test';
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true }));

    expect(relay.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_message', text: 'Enter send test' }),
    );

    await view.onClose();
  });

  it('Shift+Enter does not send message', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'T' })],
      activeThreadId: 'tid',
    });

    const inputEl = (view as never)['inputEl'] as HTMLTextAreaElement;
    inputEl.value = 'Multi-line';
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));

    expect(relay.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_message' }),
    );

    await view.onClose();
  });
});

describe('MobileView — new thread button', () => {
  it('new thread button sends create_thread command with title', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    const listPanel = (view as never)['listPanelEl'] as HTMLElement;
    const newBtn = listPanel.querySelector('.ct-mobile-new-btn') as HTMLButtonElement;
    newBtn.click();

    // MUST include title — the relay protocol requires it
    expect(relay.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'create_thread', title: expect.any(String) }),
    );

    await view.onClose();
  });
});

describe('MobileView — pairing screen', () => {
  it('shows pairing screen when relayClient is null', async () => {
    const { view } = await buildView({ noRelay: true });

    const root = (view as never)['containerEl'] as HTMLElement;
    expect(root.textContent).toContain('Not connected');

    await view.onClose();
  });
});

describe('MobileView — disconnected banner', () => {
  it('shows disconnected banner when connection state is not connected', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    relay.triggerConnectionState('reconnecting');

    const rootEl = (view as never)['rootEl'] as HTMLElement;
    expect(rootEl.querySelector('.ct-mobile-disconnected-banner')).not.toBeNull();

    await view.onClose();
  });

  it('removes disconnected banner when connected', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    relay.triggerConnectionState('reconnecting');
    relay.triggerConnectionState('connected');

    const rootEl = (view as never)['rootEl'] as HTMLElement;
    expect(rootEl.querySelector('.ct-mobile-disconnected-banner')).toBeNull();

    await view.onClose();
  });
});

describe('MobileView — scrollToBottom uses requestAnimationFrame', () => {
  it('calls requestAnimationFrame when scrolling', async () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      // Execute synchronously for test
      cb(0);
      return 0;
    });

    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'tid',
          messages: Array.from({ length: 20 }, (_, i) =>
            makeMessage({ id: `m${i}`, content: `Message ${i}` }),
          ),
        }),
      ],
      activeThreadId: 'tid',
    });

    // renderConversation calls scrollToBottom which should call requestAnimationFrame
    expect(rafSpy).toHaveBeenCalled();

    rafSpy.mockRestore();
    await view.onClose();
  });
});

describe('MobileView — message rendering', () => {
  it('renders all messages in the active thread', async () => {
    const { view, store } = await buildView();
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage({ id: `m${i}`, content: `Content ${i}`, role: i % 2 === 0 ? 'user' : 'assistant' }),
    );

    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', messages })],
      activeThreadId: 'tid',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const msgEls = messagesEl.querySelectorAll('.ct-mobile-message');
    expect(msgEls.length).toBe(10);

    await view.onClose();
  });

  it('renders compact divider for compact messages', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [
        makeThread({
          id: 'tid',
          messages: [
            makeMessage({ id: 'm1', role: 'user', content: 'Before' }),
            { id: 'c1', role: 'compact', content: '', timestamp: 500 },
            makeMessage({ id: 'm2', role: 'assistant', content: 'After' }),
          ],
        }),
      ],
      activeThreadId: 'tid',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-compact-divider')).not.toBeNull();
    // Compact divider should NOT be rendered as a regular message bubble
    const msgEls = messagesEl.querySelectorAll('.ct-mobile-message');
    expect(msgEls.length).toBe(2);

    await view.onClose();
  });

  it('renders streaming indicator when thread is streaming', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    store.applyFrame({ type: 'streaming_start', threadId: 'tid' });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-streaming')).not.toBeNull();

    await view.onClose();
  });

  it('renders streaming dot in thread list for streaming thread', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid', title: 'Streaming thread' })],
      activeThreadId: null,
    });
    store.applyFrame({ type: 'streaming_start', threadId: 'tid' });

    const threadList = (view as never)['threadListEl'] as HTMLElement;
    expect(threadList.querySelector('.ct-mobile-thread-icon-running')).not.toBeNull();

    await view.onClose();
  });
});

describe('MobileView — permission cards', () => {
  it('renders permission card for pending permission', async () => {
    const { view, store } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    store.applyFrame({
      type: 'permission_request',
      threadId: 'tid',
      toolName: 'Bash',
      detail: 'rm -rf /tmp/test',
      requestId: 'req-1',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    expect(messagesEl.querySelector('.ct-mobile-permission-card')).not.toBeNull();
    expect(messagesEl.textContent).toContain('Bash');

    await view.onClose();
  });

  it('Allow button sends resolve_permission with allow=true', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    store.applyFrame({
      type: 'permission_request',
      threadId: 'tid',
      toolName: 'Write',
      detail: 'write foo.txt',
      requestId: 'req-99',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const allowBtn = messagesEl.querySelector('.ct-mobile-permission-allow') as HTMLButtonElement;
    allowBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'resolve_permission',
      threadId: 'tid',
      requestId: 'req-99',
      allow: true,
    });

    await view.onClose();
  });

  it('Deny button sends resolve_permission with allow=false', async () => {
    const { view, store, relay } = await buildView();
    store.applyFrame({
      type: 'snapshot',
      threads: [makeThread({ id: 'tid' })],
      activeThreadId: 'tid',
    });
    store.applyFrame({
      type: 'permission_request',
      threadId: 'tid',
      toolName: 'Bash',
      detail: 'rm -rf /',
      requestId: 'req-7',
    });

    const messagesEl = (view as never)['messagesEl'] as HTMLElement;
    const denyBtn = messagesEl.querySelector('.ct-mobile-permission-deny') as HTMLButtonElement;
    denyBtn.click();

    expect(relay.sendCommand).toHaveBeenCalledWith({
      type: 'resolve_permission',
      threadId: 'tid',
      requestId: 'req-7',
      allow: false,
    });

    await view.onClose();
  });
});

describe('MobileView — cleanup', () => {
  it('unsubscribes store listener on close', async () => {
    const { view, store } = await buildView();
    store.applyFrame({ type: 'snapshot', threads: [], activeThreadId: null });

    const listenersBefore = (store as never)['listeners'] as Set<() => void>;
    const countBefore = listenersBefore.size;

    await view.onClose();

    expect(listenersBefore.size).toBeLessThan(countBefore);
  });
});

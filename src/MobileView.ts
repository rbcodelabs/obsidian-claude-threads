/**
 * MobileView.ts
 *
 * Obsidian ItemView for the mobile remote-access client. Renders threads from
 * MobileThreadStore and sends RemoteCommands via RelayClient.
 *
 * This view intentionally has no knowledge of ThreadManager, ClaudeSession, or
 * VaultPersistence — all state comes through the relay.
 */

import { ItemView, WorkspaceLeaf, sanitizeHTMLToDom } from 'obsidian';
import { marked } from 'marked';
import type { RelayClient } from './RelayClient';
import type { MobileThreadStore } from './MobileThreadStore';
import type { SerializedThread, SerializedMessage, PendingPermission } from './relay-protocol';

export const MOBILE_VIEW_TYPE = 'claude-threads:mobile';

export class MobileView extends ItemView {
  private relayClient: RelayClient | null;
  private store: MobileThreadStore | null;

  // DOM refs
  private rootEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private listPanelEl!: HTMLElement;
  private convPanelEl!: HTMLElement;
  private disconnectedBannerEl: HTMLElement | null = null;
  private threadListEl!: HTMLElement;
  private conversationEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private convTitleEl!: HTMLSpanElement;
  private showingList = false; // user pressed back — stay on list even if desktop has active thread
  private debugBarEl!: HTMLElement;

  // Cleanup handles
  private unsubStore: (() => void) | null = null;
  private unsubConnectionState: (() => void) | null = null;
  private scrollObserver: MutationObserver | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    relayClient: RelayClient | null,
    store: MobileThreadStore | null,
  ) {
    super(leaf);
    this.relayClient = relayClient;
    this.store = store;
  }

  getViewType(): string {
    return MOBILE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Claude Threads (Mobile)';
  }

  getIcon(): string {
    return 'smartphone';
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.render();

    if (this.store) {
      this.unsubStore = this.store.subscribe(() => this.render());
    }

    if (this.relayClient) {
      this.unsubConnectionState = this.relayClient.onConnectionStateChange((state) => {
        this.updateConnectionBanner(state);
      });
    }
  }

  async onClose(): Promise<void> {
    this.unsubStore?.();
    this.unsubConnectionState?.();
    this.scrollObserver?.disconnect();
    this.scrollObserver = null;
  }

  // ── UI construction ───────────────────────────────────────────────────

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    this.rootEl = root;
    root.empty();
    root.addClass('ct-mobile-root');

    // ── List panel ────────────────────────────────────────────────────
    this.listPanelEl = root.createDiv('ct-mobile-list-panel');
    const listPanel = this.listPanelEl;
    const listHeader = listPanel.createDiv('ct-mobile-list-header');
    listHeader.createEl('span', { cls: 'ct-mobile-list-title', text: 'Claude Threads' });
    const newBtn = listHeader.createEl('button', { cls: 'ct-mobile-new-btn', attr: { title: 'New thread' } });
    newBtn.createSpan({ text: '+' });
    newBtn.addEventListener('click', () => {
      this.relayClient?.sendCommand({ type: 'create_thread', title: 'New Thread' });
    });
    this.threadListEl = listPanel.createDiv('ct-mobile-thread-list');

    // ── Conversation panel ────────────────────────────────────────────
    this.convPanelEl = root.createDiv('ct-mobile-conv-panel');
    const convPanel = this.convPanelEl;
    this.headerEl = convPanel.createDiv('ct-mobile-conv-header');
    const backBtn = this.headerEl.createEl('button', { cls: 'ct-mobile-back-btn' });
    backBtn.setText('‹');
    backBtn.addEventListener('click', () => {
      this.showingList = true;
      this.showPanel('list');
    });
    this.convTitleEl = this.headerEl.createEl('span', { cls: 'ct-mobile-conv-title' });
    this.conversationEl = convPanel.createDiv('ct-mobile-conversation');
    this.messagesEl = this.conversationEl.createDiv('ct-mobile-messages');
    this.debugBarEl = this.conversationEl.createDiv('ct-mobile-debug-bar');
    this.inputRowEl = convPanel.createDiv('ct-mobile-input-row');
    const inputControls = this.inputRowEl.createDiv('ct-mobile-input-controls');
    this.inputEl = inputControls.createEl('textarea', {
      cls: 'ct-mobile-input',
      attr: { placeholder: 'Message Claude…', rows: '1' },
    });
    this.sendBtn = inputControls.createEl('button', { cls: 'ct-mobile-send-btn', text: 'Send' });
    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    // Auto-grow textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private render(): void {
    if (!this.store || !this.relayClient) {
      this.renderPairingScreen();
      return;
    }

    const threads = this.store.getThreads();
    const activeId = this.store.getActiveThreadId();

    this.renderThreadList(threads, activeId);
    this.renderConversation(activeId);

    // Switch to conversation panel when there's an active thread and the user
    // hasn't explicitly navigated back to the list.
    if (activeId && !this.showingList) {
      const thread = this.store.getThread(activeId);
      this.convTitleEl.textContent = thread?.title ?? '';
      this.showPanel('conversation');
    } else if (!activeId) {
      this.showingList = false;
      this.showPanel('list');
    }
  }

  private renderPairingScreen(): void {
    this.threadListEl.empty();
    this.messagesEl.empty();
    this.showPanel('list');

    const el = this.threadListEl.createDiv('ct-mobile-pairing');
    el.createEl('div', { cls: 'ct-mobile-pairing-icon', text: '⟳' });
    el.createEl('h3', { text: 'Not connected' });
    el.createEl('p', {
      text: 'On desktop: Settings > Claude Threads > Remote Access > enable > Show QR code.',
      cls: 'ct-mobile-pairing-text',
    });
    el.createEl('p', {
      text: 'Scan the QR code with your phone camera, or paste the pairing code in Settings.',
      cls: 'ct-mobile-pairing-text',
    });
  }

  private renderThreadList(threads: SerializedThread[], activeId: string | null): void {
    this.threadListEl.empty();

    if (threads.length === 0) {
      const empty = this.threadListEl.createDiv({ cls: 'ct-mobile-no-threads' });
      empty.createEl('p', { text: 'No threads yet.' });
      empty.createEl('p', { text: 'Create one on desktop to get started.', cls: 'ct-mobile-hint' });
      return;
    }

    for (const thread of threads) {
      const isActive = thread.id === activeId;
      const isStreaming = this.store!.isStreaming(thread.id);
      const item = this.threadListEl.createDiv({
        cls: `ct-mobile-thread-item${isActive ? ' ct-mobile-thread-item-active' : ''}`,
      });
      const meta = item.createDiv('ct-mobile-thread-meta');
      meta.createSpan({ cls: 'ct-mobile-thread-title', text: thread.title || 'Untitled' });
      const lastMsg = thread.messages.filter(m => m.role !== 'compact').at(-1);
      if (lastMsg) {
        meta.createSpan({
          cls: 'ct-mobile-thread-preview',
          text: lastMsg.content.slice(0, 80).replace(/\n/g, ' '),
        });
      }
      const right = item.createDiv('ct-mobile-thread-right');
      if (isStreaming) {
        right.createSpan({ cls: 'ct-mobile-streaming-dot', text: '●' });
      }
      right.createSpan({ cls: 'ct-mobile-thread-chevron', text: '›' });

      item.addEventListener('click', () => {
        this.showingList = false;
        // Switch panel immediately — don't wait for the store to notify and re-render.
        // This makes the tap feel instant on mobile.
        this.convTitleEl.textContent = thread.title || 'Untitled';
        this.showPanel('conversation');
        this.store!.setActiveThreadId(thread.id);
        this.relayClient!.sendCommand({ type: 'set_active_thread', threadId: thread.id });
      });
    }
  }

  private renderConversation(activeId: string | null): void {
    this.messagesEl.empty();

    if (!activeId || !this.store) {
      this.messagesEl.createDiv({ cls: 'ct-mobile-empty', text: 'Select a thread to start chatting.' });
      this.debugBarEl.textContent = '';
      return;
    }

    const thread = this.store.getThread(activeId);
    if (!thread) {
      this.debugBarEl.textContent = `store has thread? NO (id: ${activeId.slice(0, 8)})`;
      return;
    }

    // Debug: show exact message count from store so we can distinguish data vs render bugs
    const msgCount = thread.messages.length;
    const allThreads = this.store.getThreads();
    this.debugBarEl.textContent = `store: ${msgCount} msgs | ${allThreads.length} threads total`;

    // Render permission cards for this thread first
    const permissions = this.store.getPendingPermissionsForThread(activeId);
    for (const permission of permissions) {
      this.renderPermissionCard(permission);
    }

    // Render existing messages
    for (const msg of thread.messages) {
      this.renderMessage(msg);
    }

    // Streaming state
    if (this.store.isStreaming(activeId)) {
      const streamingContent = this.store.getStreamingContent(activeId);
      this.renderStreamingMessage(streamingContent);
    }

    this.scrollToBottom();
  }

  private renderMessage(msg: SerializedMessage): void {
    if (msg.role === 'compact') {
      this.messagesEl.createDiv({ cls: 'ct-mobile-compact-divider', text: 'Context compacted' });
      return;
    }

    const el = this.messagesEl.createDiv(`ct-mobile-message ct-mobile-message-${msg.role}`);
    const content = el.createDiv('ct-mobile-message-content');

    if (msg.role === 'assistant') {
      // marked v18 returns a string synchronously (not a Promise) when no async
      // extensions are configured. Calling .then() on a plain string throws
      // TypeError which propagates out of the for loop and stops all subsequent
      // messages from rendering. Call synchronously and wrap in try/catch.
      try {
        const html = marked.parse(msg.content) as string;
        content.appendChild(sanitizeHTMLToDom(html));
      } catch {
        content.createEl('p', { text: msg.content });
      }
    } else {
      content.createEl('p', { text: msg.content });
    }

    if (msg.cost && msg.cost > 0) {
      el.createSpan({ cls: 'ct-mobile-cost', text: `$${msg.cost.toFixed(4)}` });
    }
  }

  private renderStreamingMessage(content: string): void {
    const el = this.messagesEl.createDiv('ct-mobile-message ct-mobile-message-assistant ct-mobile-streaming');
    const contentEl = el.createDiv('ct-mobile-message-content');

    if (content) {
      try {
        const html = marked.parse(content) as string;
        contentEl.appendChild(sanitizeHTMLToDom(html));
        contentEl.createSpan({ cls: 'ct-cursor' });
      } catch {
        contentEl.createEl('p', { text: content });
        contentEl.createSpan({ cls: 'ct-cursor' });
      }
    } else {
      contentEl.createSpan({ cls: 'ct-thinking-label', text: 'Claude is thinking ' });
      contentEl.createSpan({ cls: 'ct-cursor' });
    }
  }

  private renderPermissionCard(permission: PendingPermission): void {
    const card = this.messagesEl.createDiv('ct-mobile-permission-card');

    card.createDiv({ cls: 'ct-mobile-permission-label', text: 'Permission request' });

    const body = card.createDiv('ct-mobile-permission-body');
    body.createEl('code', { cls: 'ct-mobile-permission-tool', text: permission.toolName });
    if (permission.detail) {
      body.createEl('p', { cls: 'ct-mobile-permission-detail', text: permission.detail });
    }

    const actions = card.createDiv('ct-mobile-permission-actions');

    const denyBtn = actions.createEl('button', {
      cls: 'ct-mobile-permission-btn ct-mobile-permission-deny',
      text: 'Deny',
    });
    denyBtn.addEventListener('click', () => {
      this.relayClient!.sendCommand({
        type: 'resolve_permission',
        threadId: permission.threadId,
        requestId: permission.requestId,
        allow: false,
      });
    });

    const allowBtn = actions.createEl('button', {
      cls: 'ct-mobile-permission-btn ct-mobile-permission-allow',
      text: 'Allow',
    });
    allowBtn.addEventListener('click', () => {
      this.relayClient!.sendCommand({
        type: 'resolve_permission',
        threadId: permission.threadId,
        requestId: permission.requestId,
        allow: true,
      });
    });
  }

  private updateConnectionBanner(state: string): void {
    if (state === 'connected') {
      this.disconnectedBannerEl?.remove();
      this.disconnectedBannerEl = null;
    } else if (!this.disconnectedBannerEl) {
      const banner = this.rootEl.createDiv('ct-mobile-disconnected-banner');
      banner.createSpan({ text: 'Desktop disconnected — reconnecting...' });
      this.disconnectedBannerEl = banner;
      // Insert at the top
      this.rootEl.insertBefore(banner, this.rootEl.firstChild);
    }
  }

  // ── Panel switching ───────────────────────────────────────────────────

  /** Directly show/hide panels without relying on CSS class cascades. */
  private showPanel(panel: 'list' | 'conversation'): void {
    if (panel === 'conversation') {
      this.listPanelEl.style.display = 'none';
      this.convPanelEl.style.display = 'flex';
    } else {
      this.convPanelEl.style.display = 'none';
      this.listPanelEl.style.display = 'flex';
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────

  private handleSend(): void {
    const text = this.inputEl.value.trim();
    if (!text || !this.store || !this.relayClient) return;

    const activeId = this.store.getActiveThreadId();
    if (!activeId) return;

    this.relayClient.sendCommand({ type: 'send_message', threadId: activeId, text });
    this.inputEl.value = '';
  }

  private scrollToBottom(): void {
    // Disconnect any previous observer before creating a new one.
    this.scrollObserver?.disconnect();
    this.scrollObserver = null;

    const doScroll = () => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    };

    // First pass: after layout is computed.
    requestAnimationFrame(() => {
      doScroll();

      // Second pass: watch for async DOM mutations (marked.parse() populating
      // assistant message content) and re-scroll each time something changes.
      // Disconnect automatically after 2 s so we don't observe forever.
      const observer = new MutationObserver(() => {
        doScroll();
      });
      observer.observe(this.messagesEl, { childList: true, subtree: true, characterData: true });
      this.scrollObserver = observer;

      setTimeout(() => {
        observer.disconnect();
        if (this.scrollObserver === observer) this.scrollObserver = null;
        doScroll(); // Final scroll after everything has settled.
      }, 2000);
    });
  }
}

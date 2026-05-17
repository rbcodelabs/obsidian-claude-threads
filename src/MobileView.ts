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
  private disconnectedBannerEl: HTMLElement | null = null;
  private threadListEl!: HTMLElement;
  private conversationEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;

  // Cleanup handles
  private unsubStore: (() => void) | null = null;
  private unsubConnectionState: (() => void) | null = null;

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
  }

  // ── UI construction ───────────────────────────────────────────────────

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    this.rootEl = root;
    root.empty();
    root.addClass('ct-mobile-root');

    this.headerEl = root.createDiv('ct-mobile-header');

    // Thread list sidebar
    this.threadListEl = root.createDiv('ct-mobile-thread-list');

    // Conversation panel
    this.conversationEl = root.createDiv('ct-mobile-conversation');
    this.messagesEl = this.conversationEl.createDiv('ct-mobile-messages');

    // Input area
    this.inputRowEl = this.conversationEl.createDiv('ct-mobile-input-row');
    const inputControls = this.inputRowEl.createDiv('ct-mobile-input-controls');
    this.inputEl = inputControls.createEl('textarea', {
      cls: 'ct-mobile-input',
      attr: { placeholder: 'Message Claude...' },
    });
    this.sendBtn = inputControls.createEl('button', {
      cls: 'ct-mobile-send-btn',
      text: 'Send',
    });

    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
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
  }

  private renderPairingScreen(): void {
    this.messagesEl.empty();
    this.threadListEl.empty();

    const pairingEl = this.messagesEl.createDiv('ct-mobile-pairing');
    pairingEl.createEl('h2', { text: 'Connect to Desktop' });
    pairingEl.createEl('p', {
      text: 'Pair with your desktop to get started. Open Claude Threads on your desktop, go to Settings > Remote Access, and scan the QR code or enter the pairing code.',
      cls: 'ct-mobile-pairing-text',
    });
  }

  private renderThreadList(threads: SerializedThread[], activeId: string | null): void {
    this.threadListEl.empty();

    if (threads.length === 0) {
      this.threadListEl.createDiv({ cls: 'ct-mobile-no-threads', text: 'No threads yet.' });
      return;
    }

    for (const thread of threads) {
      const item = this.threadListEl.createDiv({
        cls: `ct-mobile-thread-item${thread.id === activeId ? ' ct-mobile-thread-item-active' : ''}`,
      });
      item.createSpan({ cls: 'ct-mobile-thread-title', text: thread.title });

      const isStreaming = this.store!.isStreaming(thread.id);
      if (isStreaming) {
        item.createSpan({ cls: 'ct-mobile-streaming-dot', text: '●' });
      }

      item.addEventListener('click', () => {
        this.store!.setActiveThreadId(thread.id);
        this.relayClient!.sendCommand({ type: 'set_active_thread', threadId: thread.id });
      });
    }
  }

  private renderConversation(activeId: string | null): void {
    this.messagesEl.empty();

    if (!activeId || !this.store) {
      this.messagesEl.createDiv({ cls: 'ct-mobile-empty', text: 'Select a thread to start chatting.' });
      return;
    }

    const thread = this.store.getThread(activeId);
    if (!thread) return;

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
      marked.parse(msg.content).then((html) => {
        content.appendChild(sanitizeHTMLToDom(html));
      }).catch(() => {
        content.createEl('p', { text: msg.content });
      });
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
      marked.parse(content).then((html) => {
        contentEl.appendChild(sanitizeHTMLToDom(html));
        contentEl.createSpan({ cls: 'ct-cursor' });
      }).catch(() => {
        contentEl.createEl('p', { text: content });
        contentEl.createSpan({ cls: 'ct-cursor' });
      });
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
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

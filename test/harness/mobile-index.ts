/**
 * Mobile harness entry point.
 *
 * Renders MobileView in two states controlled by the ?view= query param:
 *   ?view=mobile-pairing   — no relay/store configured (shows pairing screen)
 *   ?view=mobile-connected — mock relay + seeded MobileThreadStore (shows thread list)
 */
import './obsidian-mock';
import { MobileView } from '../../src/MobileView';
import { MobileThreadStore } from '../../src/MobileThreadStore';
import { mockLeaf } from './obsidian-mock';
import { fixtureThreads } from './fixtures';
import type { RelayFrame } from '../../src/relay-protocol';

// ── Minimal RelayClient mock ───────────────────────────────────────────────

type FrameListener = (frame: RelayFrame) => void;
type ConnectionStateListener = (state: string) => void;

class MockRelayClient {
  private frameListeners: Set<FrameListener> = new Set();
  private connectionListeners: Set<ConnectionStateListener> = new Set();

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onConnectionStateChange(listener: ConnectionStateListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  isConnected(): boolean { return true; }
  getConnectionState(): string { return 'connected'; }
  sendCommand(_cmd: unknown): void {}
  connect(): void {}
  disconnect(): void {}
}

// ── Query-param routing ────────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const view = params.get('view') ?? 'mobile-pairing';

const app = document.getElementById('app')!;

if (view === 'mobile-connected') {
  // Build a MobileThreadStore seeded from fixture threads and make the first
  // thread active with streaming in progress.
  const store = new MobileThreadStore();
  const relay = new MockRelayClient();

  // Hydrate from a snapshot using fixture threads.
  store.applyFrame({
    type: 'snapshot',
    threads: fixtureThreads.map((t) => ({
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      messages: t.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        toolCalls: m.toolCalls,
        cost: m.cost,
      })),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      summary: t.summary,
      recap: t.recap,
      lastError: t.lastError,
    })),
    activeThreadId: fixtureThreads[0].id,
  });

  // Simulate a streaming message on the active thread so the connected view
  // has visible activity.
  store.applyFrame({ type: 'streaming_start', threadId: fixtureThreads[0].id });
  store.applyFrame({ type: 'token', threadId: fixtureThreads[0].id, text: 'Working on it...' });

  const mobileView = new MobileView(mockLeaf as any, relay as any, store);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();

  (window as any).__mobileView = mobileView;
  (window as any).__store = store;
} else {
  // Pairing screen: pass null relay + null store
  const mobileView = new MobileView(mockLeaf as any, null, null);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();

  (window as any).__mobileView = mobileView;
}

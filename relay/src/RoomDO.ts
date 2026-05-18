/**
 * RoomDO — Cloudflare Durable Object that manages a single relay room.
 *
 * Each room holds exactly two WebSocket slots: one for the desktop client
 * (role=desktop) and one for the mobile client (role=mobile). All frames
 * are forwarded verbatim between the two slots. The DO uses the Hibernatable
 * WebSocket API so it does not need to stay in memory between messages.
 */
export class RoomDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');

    if (role !== 'desktop' && role !== 'mobile') {
      return new Response('Missing or invalid ?role= parameter (must be desktop or mobile)', { status: 400 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Reject a second mobile connection while one is already active
    if (role === 'mobile') {
      const existing = this.state.getWebSockets('mobile');
      if (existing.length > 0) {
        return new Response('A mobile client is already connected to this room', { status: 409 });
      }
    }

    // Reject a second desktop connection — the reconnect flow is handled by closing
    // the old socket first, but we accept the new one immediately so the old one
    // receives a close event. We tag the new socket before accepting.
    if (role === 'desktop') {
      const existing = this.state.getWebSockets('desktop');
      for (const ws of existing) {
        ws.close(1000, 'Replaced by new desktop connection');
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server, [role]);

    // Notify the peer that the other side has connected / reconnected
    if (role === 'mobile') {
      const desktopSockets = this.state.getWebSockets('desktop');
      for (const ws of desktopSockets) {
        try {
          ws.send(JSON.stringify({ type: 'mobile_joined' }));
        } catch {
          // Desktop may have just disconnected; ignore
        }
      }
    } else {
      // Desktop reconnected — notify mobile so it can clear stale state
      const mobileSockets = this.state.getWebSockets('mobile');
      for (const ws of mobileSockets) {
        try {
          ws.send(JSON.stringify({ type: 'desktop_reconnected' }));
        } catch {
          // Mobile may have just disconnected; ignore
        }
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernatable WebSocket handlers

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const tags = this.state.getTags(ws);
    const senderRole = tags[0]; // 'desktop' or 'mobile'
    const targetRole = senderRole === 'desktop' ? 'mobile' : 'desktop';

    const targets = this.state.getWebSockets(targetRole);
    for (const target of targets) {
      try {
        target.send(message);
      } catch {
        // Target closed between getWebSockets and send; ignore
      }
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string): void {
    ws.close();
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    ws.close();
  }
}

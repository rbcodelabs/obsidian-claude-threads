/**
 * Cloudflare Worker entrypoint for the Claude Threads relay.
 *
 * Routes WebSocket upgrade requests to the appropriate RoomDO instance.
 * URL pattern: /room/:roomId?role=desktop|mobile
 */
import { RoomDO } from './RoomDO';

export { RoomDO };

interface Env {
  ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/');

    // Expect /room/:roomId
    if (parts[1] !== 'room' || !parts[2]) {
      return new Response('Not found. Use /room/:roomId?role=desktop|mobile', { status: 404 });
    }

    const roomId = parts[2];

    // Route to the Durable Object for this room
    const id = env.ROOMS.idFromName(roomId);
    const stub = env.ROOMS.get(id);

    return stub.fetch(request);
  },
};

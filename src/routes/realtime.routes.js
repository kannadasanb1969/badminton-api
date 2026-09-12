import { authorizeRealtime, getMatchRoomName, RealtimeError } from '../services/realtime.service.js';

export async function handleRealtimeRoutes(request, env) {
  try {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/realtime\/matches\/([^/]+)$/);
    if (request.method !== 'GET' || !match) return new Response('API endpoint not found', { status: 404 });
    const matchId = decodeURIComponent(match[1]);
    const token = url.searchParams.get('token') || request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    await authorizeRealtime(env, matchId, token);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
    const id = env.MATCH_LIVE_ROOM.idFromName(getMatchRoomName(matchId));
    return env.MATCH_LIVE_ROOM.get(id).fetch(request);
  } catch (error) {
    if (error instanceof RealtimeError) return Response.json({ success: false, message: error.message }, { status: error.status });
    console.error('Realtime request failed', { message: error.message });
    return Response.json({ success: false, message: 'Unable to open realtime connection' }, { status: 500 });
  }
}

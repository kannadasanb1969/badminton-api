export class MatchLiveRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === 'POST') {
      const event = await request.json();
      this.broadcast(event);
      return new Response('ok');
    }

    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(event) {
    const payload = JSON.stringify(event);
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(payload); } catch { socket.close(1011, 'Broadcast failed'); }
    }
  }

  webSocketMessage() {}
  webSocketClose() {}
  webSocketError() {}
}

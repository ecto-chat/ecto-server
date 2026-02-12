import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';

export function setupMainWebSocket(_server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (_ws) => {
    // TODO: Handle system.identify, heartbeat, subscriptions
  });

  return wss;
}

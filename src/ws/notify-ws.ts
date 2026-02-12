import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';

export function setupNotifyWebSocket(_server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (_ws) => {
    // TODO: Handle identify, send lightweight notifications
  });

  return wss;
}

import { WebSocketServer, type WebSocket } from 'ws';
import { generateUUIDv7, HEARTBEAT_INTERVAL, WsCloseCode } from 'ecto-shared';
import type { WsMessage } from 'ecto-shared';
import { verifyToken } from '../middleware/auth.js';

interface NotifyClient {
  userId: string;
  ws: WebSocket;
  lastHeartbeat: number;
  debounce: Map<string, number>; // channelId → last notify timestamp
}

const DEBOUNCE_MS = 2000;
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL + 5000;

const clients = new Map<string, NotifyClient>();

export function setupNotifyWebSocket(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    const sessionId = generateUUIDv7();

    ws.send(JSON.stringify({
      event: 'system.hello',
      data: { heartbeat_interval: HEARTBEAT_INTERVAL, session_id: sessionId },
    }));

    let authenticated = false;
    const identifyTimeout = setTimeout(() => {
      if (!authenticated) ws.close(WsCloseCode.NOT_AUTHENTICATED, 'Identify timeout');
    }, 10_000);

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    ws.on('message', async (raw) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsMessage;
      } catch {
        ws.close(WsCloseCode.INVALID_PAYLOAD, 'Invalid JSON');
        return;
      }

      if (msg.event === 'system.identify') {
        if (authenticated) {
          ws.close(WsCloseCode.ALREADY_AUTHENTICATED, 'Already identified');
          return;
        }

        const payload = msg.data as { token: string };
        if (!payload?.token) {
          ws.close(WsCloseCode.AUTHENTICATION_FAILED, 'No token');
          return;
        }

        try {
          const user = await verifyToken(payload.token);
          authenticated = true;
          clearTimeout(identifyTimeout);

          const client: NotifyClient = {
            userId: user.id,
            ws,
            lastHeartbeat: Date.now(),
            debounce: new Map(),
          };
          clients.set(sessionId, client);

          ws.send(JSON.stringify({ event: 'system.ready', data: { session_id: sessionId } }));

          heartbeatTimer = setInterval(() => {
            if (Date.now() - client.lastHeartbeat > HEARTBEAT_TIMEOUT) {
              ws.close(WsCloseCode.SESSION_TIMEOUT, 'Heartbeat timeout');
            }
          }, HEARTBEAT_TIMEOUT);
        } catch {
          ws.close(WsCloseCode.AUTHENTICATION_FAILED, 'Auth failed');
        }
        return;
      }

      if (!authenticated) {
        ws.close(WsCloseCode.NOT_AUTHENTICATED, 'Not authenticated');
        return;
      }

      const client = clients.get(sessionId);
      if (!client) return;

      if (msg.event === 'system.heartbeat') {
        client.lastHeartbeat = Date.now();
        ws.send(JSON.stringify({ event: 'system.heartbeat_ack', data: {} }));
      }
    });

    ws.on('close', () => {
      clearTimeout(identifyTimeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      clients.delete(sessionId);
    });

    ws.on('error', () => ws.close());
  });

  return wss;
}

export function sendNotification(userId: string, channelId: string, type: string) {
  const now = Date.now();
  for (const client of clients.values()) {
    if (client.userId !== userId) continue;

    // Debounce: max 1 per channel per 2s
    const lastSent = client.debounce.get(channelId) ?? 0;
    if (now - lastSent < DEBOUNCE_MS) continue;

    client.debounce.set(channelId, now);
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify({
        event: 'notify',
        data: { channel_id: channelId, ts: Date.now(), type },
      }));
    }

    // Prune stale debounce entries to prevent unbounded growth
    if (client.debounce.size > 100) {
      const staleThreshold = now - DEBOUNCE_MS * 2;
      for (const [chId, ts] of client.debounce) {
        if (ts < staleThreshold) client.debounce.delete(chId);
      }
    }
  }
}

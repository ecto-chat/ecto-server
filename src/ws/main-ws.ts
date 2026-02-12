import { WebSocketServer, type WebSocket } from 'ws';
import { generateUUIDv7, HEARTBEAT_INTERVAL, PROTOCOL_VERSION, WsCloseCode } from 'ecto-shared';
import type { WsMessage } from 'ecto-shared';
import { eventDispatcher } from './event-dispatcher.js';
import { verifyToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import {
  servers,
  members,
  channels,
  categories,
  roles,
  readStates,
  memberRoles,
} from '../db/schema/index.js';
import { eq, and, inArray } from 'drizzle-orm';
import { formatServer, formatChannel, formatCategory, formatRole, formatMember, formatReadState, formatVoiceState } from '../utils/format.js';
import { resolveUserProfiles } from '../utils/resolve-profile.js';
import { presenceManager } from '../services/presence.js';
import { voiceStateManager } from '../services/voice-state.js';
import { requirePermission, buildPermissionContext } from '../utils/permission-context.js';
import { computePermissions, hasPermission, Permissions } from 'ecto-shared';
import { rateLimiter } from '../middleware/rate-limit.js';
import { handleVoiceMessage } from './handlers/voice.js';
import { voiceManager } from '../voice/index.js';

const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL + 5000;

interface PendingSession {
  ws: WebSocket;
  sessionId: string;
  timeout: ReturnType<typeof setTimeout>;
}

export function setupMainWebSocket(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    const sessionId = generateUUIDv7();

    // Send system.hello
    const hello: WsMessage = {
      event: 'system.hello',
      data: { heartbeat_interval: HEARTBEAT_INTERVAL, session_id: sessionId },
    };
    ws.send(JSON.stringify(hello));

    // Expect system.identify within 10 seconds
    let authenticated = false;
    const identifyTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.close(WsCloseCode.NOT_AUTHENTICATED, 'Identify timeout');
      }
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

        const payload = msg.data as { token: string; protocol_version?: number };
        if (!payload?.token) {
          ws.close(WsCloseCode.AUTHENTICATION_FAILED, 'No token');
          return;
        }

        if (payload.protocol_version && payload.protocol_version !== PROTOCOL_VERSION) {
          ws.close(WsCloseCode.PROTOCOL_VERSION_MISMATCH, 'Protocol version mismatch');
          return;
        }

        try {
          const user = await verifyToken(payload.token);
          const d = db();

          // Verify membership
          const [server] = await d.select().from(servers).limit(1);
          if (!server) { ws.close(WsCloseCode.UNKNOWN_ERROR, 'No server'); return; }

          const [member] = await d
            .select()
            .from(members)
            .where(and(eq(members.serverId, server.id), eq(members.userId, user.id)))
            .limit(1);

          if (!member) {
            ws.close(WsCloseCode.AUTHENTICATION_FAILED, 'Not a member');
            return;
          }

          authenticated = true;
          clearTimeout(identifyTimeout);

          const session = eventDispatcher.addSession(sessionId, user.id, ws);

          // Set user online
          presenceManager.update(user.id, 'online', null);

          // Build system.ready payload
          const [allChannels, allCategories, allRoles, userReadStates] = await Promise.all([
            d.select().from(channels).where(eq(channels.serverId, server.id)),
            d.select().from(categories).where(eq(categories.serverId, server.id)),
            d.select().from(roles).where(eq(roles.serverId, server.id)),
            d.select().from(readStates).where(eq(readStates.userId, user.id)),
          ]);

          // Get members (max 1000)
          const memberRows = await d.select().from(members).where(eq(members.serverId, server.id)).limit(1000);
          const memberUserIds = memberRows.map((m) => m.userId);
          const profiles = await resolveUserProfiles(d, memberUserIds);

          const allMemberRoles = memberRows.length > 0
            ? await d.select().from(memberRoles).where(inArray(memberRoles.memberId, memberRows.map((m) => m.id)))
            : [];
          const rolesByMember = new Map<string, string[]>();
          for (const mr of allMemberRoles) {
            const arr = rolesByMember.get(mr.memberId) ?? [];
            arr.push(mr.roleId);
            rolesByMember.set(mr.memberId, arr);
          }

          const presences = presenceManager.getAllForMembers(memberUserIds);
          const voiceStates = voiceStateManager.getAllStates();

          const ready: WsMessage = {
            event: 'system.ready',
            data: {
              session_id: sessionId,
              user_id: user.id,
              protocol_version: PROTOCOL_VERSION,
              server: formatServer(server),
              channels: allChannels.map(formatChannel),
              categories: allCategories.map(formatCategory),
              roles: allRoles.map(formatRole),
              members: memberRows.map((m) => {
                const profile = profiles.get(m.userId) ?? { username: 'Unknown', display_name: null, avatar_url: null };
                return formatMember(m, profile, rolesByMember.get(m.id) ?? []);
              }),
              read_states: userReadStates.map(formatReadState),
              presences: [...presences.entries()].map(([uid, p]) => ({
                user_id: uid,
                status: p.status,
                custom_text: p.customText,
                last_active_at: new Date().toISOString(),
              })),
              voice_states: voiceStates.map(formatVoiceState),
            },
          };
          ws.send(JSON.stringify(ready));

          // Start heartbeat check
          heartbeatTimer = setInterval(() => {
            if (Date.now() - session.lastHeartbeat > HEARTBEAT_TIMEOUT) {
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

      const session = eventDispatcher.getSession(sessionId);
      if (!session) return;

      switch (msg.event) {
        case 'system.heartbeat': {
          session.lastHeartbeat = Date.now();
          ws.send(JSON.stringify({ event: 'system.heartbeat_ack', data: {} }));
          break;
        }

        case 'system.resume': {
          const resumePayload = msg.data as { session_id: string; last_seq: number };
          const buffered = eventDispatcher.getEventBuffer(sessionId, resumePayload.last_seq);
          for (const entry of buffered) {
            ws.send(JSON.stringify({ event: entry.event, data: entry.data, seq: entry.seq }));
          }
          ws.send(JSON.stringify({ event: 'system.resumed', data: { replayed: buffered.length } }));
          break;
        }

        case 'subscribe': {
          const subData = msg.data as { channel_id: string };
          if (subData?.channel_id) {
            try {
              const d = db();
              const permCtx = await buildPermissionContext(d, (await d.select().from(servers).limit(1))[0]!.id, session.userId, subData.channel_id);
              if (hasPermission(computePermissions(permCtx), Permissions.READ_MESSAGES)) {
                eventDispatcher.subscribe(sessionId, subData.channel_id);
                ws.send(JSON.stringify({ event: 'subscribed', data: { channel_id: subData.channel_id } }));
              }
            } catch {
              // Permission denied
            }
          }
          break;
        }

        case 'unsubscribe': {
          const unsubData = msg.data as { channel_id: string };
          if (unsubData?.channel_id) {
            eventDispatcher.unsubscribe(sessionId, unsubData.channel_id);
            ws.send(JSON.stringify({ event: 'unsubscribed', data: { channel_id: unsubData.channel_id } }));
          }
          break;
        }

        case 'typing.start': {
          const typingData = msg.data as { channel_id: string };
          if (typingData?.channel_id) {
            if (rateLimiter.check(`typing:${session.userId}:${typingData.channel_id}`, 1, 3000)) {
              eventDispatcher.dispatchToChannel(typingData.channel_id, 'typing.start', {
                channel_id: typingData.channel_id,
                user_id: session.userId,
                timestamp: new Date().toISOString(),
              });
            }
          }
          break;
        }

        case 'presence.update': {
          const presData = msg.data as { status: string; custom_text?: string | null };
          if (presData?.status) {
            presenceManager.update(
              session.userId,
              presData.status as 'online' | 'idle' | 'dnd' | 'offline',
              presData.custom_text ?? null,
            );
            eventDispatcher.dispatchToAll('presence.update', {
              user_id: session.userId,
              status: presData.status,
              custom_text: presData.custom_text ?? null,
              last_active_at: new Date().toISOString(),
            });
          }
          break;
        }

        default: {
          // Voice events
          if (msg.event.startsWith('voice.')) {
            await handleVoiceMessage(session, msg);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(identifyTimeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);

      const session = eventDispatcher.getSession(sessionId);
      if (session) {
        // Clean up voice state if user was in voice
        const voiceState = voiceStateManager.getByUser(session.userId);
        if (voiceState) {
          voiceStateManager.leave(session.userId);
          voiceManager.leaveChannel(session.userId).catch(() => {});
          eventDispatcher.dispatchToAll('voice.state_update', {
            ...formatVoiceState(voiceState),
            _removed: true,
          });
        }

        // Set offline if no other sessions
        const otherSessions = eventDispatcher.getSessionsByUser(session.userId);
        if (otherSessions.length <= 1) {
          presenceManager.update(session.userId, 'offline', null);
          eventDispatcher.dispatchToAll('presence.update', {
            user_id: session.userId,
            status: 'offline',
            custom_text: null,
            last_active_at: new Date().toISOString(),
          });
        }
        eventDispatcher.removeSession(sessionId);
      }
    });

    ws.on('error', () => {
      ws.close();
    });
  });

  return wss;
}

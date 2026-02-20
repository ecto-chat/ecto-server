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
  serverConfig,
  dmConversations,
} from '../db/schema/index.js';
import { eq, and, or, inArray } from 'drizzle-orm';
import { formatServer, formatChannel, formatCategory, formatRole, formatMember, formatReadState, formatVoiceState } from '../utils/format.js';
import { resolveUserProfiles } from '../utils/resolve-profile.js';
import { presenceManager } from '../services/presence.js';
import { voiceStateManager } from '../services/voice-state.js';
import { requirePermission, buildPermissionContext, buildBatchPermissionContext } from '../utils/permission-context.js';
import { computePermissions, hasPermission, Permissions } from 'ecto-shared';
import { rateLimiter } from '../middleware/rate-limit.js';
import { handleVoiceMessage } from './handlers/voice.js';
import { cleanupVoiceState } from '../utils/voice-cleanup.js';
import { wsMessageSchema, identifySchema, resumeSchema, channelSubSchema, typingSchema, presenceSchema, serverDmTypingSchema } from './schemas.js';

const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 3; // 90s — generous for browser tab throttling
const OFFLINE_GRACE_PERIOD = 15_000; // 15s — delay before broadcasting offline to allow reconnect

/** Pending offline broadcast timers, keyed by userId. Cleared when user reconnects within grace period. */
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    let voiceMessageQueue: Promise<void> = Promise.resolve();
    let userId: string | null = null;

    ws.on('message', async (raw) => {
      const parsed = wsMessageSchema.safeParse((() => { try { return JSON.parse(raw.toString()); } catch { return null; } })());
      if (!parsed.success) {
        ws.close(WsCloseCode.INVALID_PAYLOAD, 'Invalid JSON');
        return;
      }
      const msg = parsed.data;

      if (msg.event === 'system.identify') {
        if (authenticated) {
          ws.close(WsCloseCode.ALREADY_AUTHENTICATED, 'Already identified');
          return;
        }

        const identifyResult = identifySchema.safeParse(msg.data);
        if (!identifyResult.success) {
          ws.close(WsCloseCode.AUTHENTICATION_FAILED, 'Invalid identify payload');
          return;
        }
        const payload = identifyResult.data;

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
          userId = user.id;

          // Cancel any pending offline timer from a previous session
          const pendingTimer = offlineTimers.get(user.id);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            offlineTimers.delete(user.id);
          }

          // Set user online
          presenceManager.update(user.id, 'online', null);

          // Build system.ready payload
          const [allChannels, allCategories, allRoles, userReadStates, [srvConfig]] = await Promise.all([
            d.select().from(channels).where(eq(channels.serverId, server.id)),
            d.select().from(categories).where(eq(categories.serverId, server.id)),
            d.select().from(roles).where(eq(roles.serverId, server.id)),
            d.select().from(readStates).where(eq(readStates.userId, user.id)),
            d.select().from(serverConfig).where(eq(serverConfig.serverId, server.id)).limit(1),
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

          // Filter channels by READ_MESSAGES permission
          const channelIds = allChannels.map((ch) => ch.id);
          const permCtxMap = await buildBatchPermissionContext(d, server.id, user.id, channelIds);
          const visibleChannels = allChannels.filter((ch) => {
            const pCtx = permCtxMap.get(ch.id);
            if (!pCtx) return false;
            return hasPermission(computePermissions(pCtx), Permissions.READ_MESSAGES);
          });

          // Only include categories that have visible channels (or user has MANAGE_CHANNELS)
          const visibleCategoryIds = new Set(visibleChannels.map((ch) => ch.categoryId).filter(Boolean));
          const serverPermCtx = permCtxMap.values().next().value;
          const userHasManageChannels = serverPermCtx
            ? hasPermission(computePermissions({ isOwner: serverPermCtx.isOwner, everyonePermissions: serverPermCtx.everyonePermissions, rolePermissions: serverPermCtx.rolePermissions }), Permissions.MANAGE_CHANNELS)
            : false;
          const visibleCategories = allCategories.filter((cat) =>
            visibleCategoryIds.has(cat.id) || userHasManageChannels,
          );

          const ready: WsMessage = {
            event: 'system.ready',
            data: {
              session_id: sessionId,
              user_id: user.id,
              protocol_version: PROTOCOL_VERSION,
              server: formatServer(server, srvConfig),
              channels: visibleChannels.map((ch) => {
                const pCtx = permCtxMap.get(ch.id);
                return formatChannel(ch, pCtx ? computePermissions(pCtx) : 0);
              }),
              categories: visibleCategories.map(formatCategory),
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

          // Broadcast online status to all other users
          eventDispatcher.dispatchToAll('presence.update', {
            user_id: user.id,
            status: 'online',
            custom_text: null,
            last_active_at: new Date().toISOString(),
          });

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
          const resumeResult = resumeSchema.safeParse(msg.data);
          if (!resumeResult.success) break;
          const resumePayload = resumeResult.data;
          const buffered = eventDispatcher.getEventBuffer(sessionId, resumePayload.last_seq);
          for (const entry of buffered) {
            ws.send(JSON.stringify({ event: entry.event, data: entry.data, seq: entry.seq }));
          }
          ws.send(JSON.stringify({ event: 'system.resumed', data: { replayed: buffered.length } }));
          break;
        }

        case 'subscribe': {
          const subResult = channelSubSchema.safeParse(msg.data);
          if (subResult.success) {
            const subData = subResult.data;
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
          const unsubResult = channelSubSchema.safeParse(msg.data);
          if (unsubResult.success) {
            eventDispatcher.unsubscribe(sessionId, unsubResult.data.channel_id);
            ws.send(JSON.stringify({ event: 'unsubscribed', data: { channel_id: unsubResult.data.channel_id } }));
          }
          break;
        }

        case 'typing.start': {
          const typingResult = typingSchema.safeParse(msg.data);
          if (typingResult.success) {
            const typingData = typingResult.data;
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

        case 'typing.stop': {
          const stopResult = typingSchema.safeParse(msg.data);
          if (stopResult.success) {
            eventDispatcher.dispatchToChannel(stopResult.data.channel_id, 'typing.stop', {
              channel_id: stopResult.data.channel_id,
              user_id: session.userId,
            });
          }
          break;
        }

        case 'presence.update': {
          const presResult = presenceSchema.safeParse(msg.data);
          if (presResult.success) {
            const presData = presResult.data;
            presenceManager.update(
              session.userId,
              presData.status,
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

        case 'server_dm.typing': {
          const dmTypingResult = serverDmTypingSchema.safeParse(msg.data);
          if (dmTypingResult.success) {
            const { conversation_id } = dmTypingResult.data;
            if (rateLimiter.check(`dm_typing:${session.userId}:${conversation_id}`, 1, 3000)) {
              const d = db();
              const [server] = await d.select().from(servers).limit(1);
              if (server) {
                const [convo] = await d
                  .select()
                  .from(dmConversations)
                  .where(
                    and(
                      eq(dmConversations.id, conversation_id),
                      eq(dmConversations.serverId, server.id),
                      or(
                        eq(dmConversations.userA, session.userId),
                        eq(dmConversations.userB, session.userId),
                      ),
                    ),
                  )
                  .limit(1);
                if (convo) {
                  const peerId = convo.userA === session.userId ? convo.userB : convo.userA;
                  eventDispatcher.dispatchToUser(peerId, 'server_dm.typing', {
                    conversation_id,
                    user_id: session.userId,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }
          }
          break;
        }

        default: {
          // Voice events — serialize per session to prevent race conditions
          if (msg.event.startsWith('voice.')) {
            voiceMessageQueue = voiceMessageQueue
              .then(() => handleVoiceMessage(session, msg))
              .catch((err) => { console.error('[ws] voice handler error:', msg.event, err); });
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
        const closingUserId = session.userId;

        // Clean up voice state only if THIS session owns it
        cleanupVoiceState(closingUserId, sessionId);

        // Remove session immediately so the new connection can take over
        eventDispatcher.removeSession(sessionId);

        // Delay offline broadcast to allow reconnection
        const remainingSessions = eventDispatcher.getSessionsByUser(closingUserId);
        if (remainingSessions.length === 0) {
          offlineTimers.set(closingUserId, setTimeout(() => {
            offlineTimers.delete(closingUserId);
            // Re-check after grace period — user may have reconnected
            if (eventDispatcher.getSessionsByUser(closingUserId).length === 0) {
              presenceManager.remove(closingUserId);
              eventDispatcher.dispatchToAll('presence.update', {
                user_id: closingUserId,
                status: 'offline',
                custom_text: null,
                last_active_at: new Date().toISOString(),
              });
            }
          }, OFFLINE_GRACE_PERIOD));
        }
      }
    });

    ws.on('error', () => {
      ws.close();
    });
  });

  return wss;
}

import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { generateUUIDv7, HEARTBEAT_INTERVAL, PROTOCOL_VERSION, WsCloseCode, ServerWsEvents } from 'ecto-shared';
import type { WsMessage } from 'ecto-shared';
import { eventDispatcher } from './event-dispatcher.js';
import { getCurrentSeq, getEventsSince } from './event-buffer.js';
import { verifyToken } from '../middleware/auth.js';
import { resolveServerId } from '../trpc/context.js';
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
  activityItems,
  messages,
} from '../db/schema/index.js';
import { eq, and, or, inArray, count as countFn, sql, desc } from 'drizzle-orm';
import { hydrateMessages } from '../utils/message-helpers.js';
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

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
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

          // Resolve which server this connection is for
          const serverId = await resolveServerId(req);
          if (!serverId) { ws.close(WsCloseCode.UNKNOWN_ERROR, 'No server'); return; }

          const [server] = await d.select().from(servers).where(eq(servers.id, serverId)).limit(1);
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
          session.serverId = serverId;
          userId = user.id;

          // Cancel any pending offline timer from a previous session
          const pendingTimer = offlineTimers.get(user.id);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            offlineTimers.delete(user.id);
          }

          // Set user online
          presenceManager.update(user.id, 'online', null);

          // Broadcast online status early (needed for both resume and full ready)
          eventDispatcher.dispatchToServer(serverId, ServerWsEvents.PRESENCE_UPDATE, {
            user_id: user.id,
            status: 'online',
            custom_text: null,
            last_active_at: new Date().toISOString(),
          });

          // Attempt server-level resume if client provided resume_seq
          if (payload.resume_seq != null) {
            const missedEvents = getEventsSince(serverId, payload.resume_seq);
            if (missedEvents !== null) {
              // Resume successful — send missed events + new resume_seq
              const resumed: WsMessage = {
                event: 'system.resumed',
                data: {
                  events: missedEvents.map(e => ({ event: e.event, data: e.data })),
                  resume_seq: getCurrentSeq(serverId),
                },
              };
              ws.send(JSON.stringify(resumed));

              // Start heartbeat check
              heartbeatTimer = setInterval(() => {
                if (Date.now() - session.lastHeartbeat > HEARTBEAT_TIMEOUT) {
                  ws.close(WsCloseCode.SESSION_TIMEOUT, 'Heartbeat timeout');
                }
              }, HEARTBEAT_TIMEOUT);

              return; // Skip full system.ready
            }
            // Buffer too old — fall through to full system.ready
          }

          // Build system.ready payload
          const [allChannels, allCategories, allRoles, userReadStates, [srvConfig]] = await Promise.all([
            d.select().from(channels).where(eq(channels.serverId, server.id)),
            d.select().from(categories).where(eq(categories.serverId, server.id)),
            d.select().from(roles).where(eq(roles.serverId, server.id)),
            d.select().from(readStates).where(eq(readStates.userId, user.id)),
            d.select().from(serverConfig).where(eq(serverConfig.serverId, server.id)).limit(1),
          ]);

          // Fetch only the connecting user's own member row
          const selfMember = await d.select().from(members).where(and(eq(members.serverId, server.id), eq(members.userId, user.id))).limit(1);
          let formattedSelfMember: ReturnType<typeof formatMember> | null = null;
          if (selfMember[0]) {
            const selfProfile = await resolveUserProfiles(d, [user.id]);
            const selfMemberRoles = await d.select().from(memberRoles).where(eq(memberRoles.memberId, selfMember[0].id));
            const selfRoleIds = selfMemberRoles.map((mr) => mr.roleId);
            const profile = selfProfile.get(user.id) ?? { username: 'Unknown', display_name: null, avatar_url: null };
            formattedSelfMember = formatMember(selfMember[0], profile, selfRoleIds);
          }

          const voiceStates = voiceStateManager.getAllStates();

          // Only send presences for users in voice channels + the connecting user
          const voiceUserIds = new Set(voiceStates.map((vs) => vs.userId));
          voiceUserIds.add(user.id);
          const presenceUserIds = [...voiceUserIds];
          const presences = presenceManager.getAllForMembers(presenceUserIds);

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

          // Activity unread counts (split by type)
          const [activityCounts] = await d
            .select({
              notifications: sql<number>`count(*) filter (where ${activityItems.type} != 'server_dm')`,
              server_dms: sql<number>`count(*) filter (where ${activityItems.type} = 'server_dm')`,
            })
            .from(activityItems)
            .where(and(eq(activityItems.userId, user.id), eq(activityItems.read, false)));
          const activityUnreadNotifications = Number(activityCounts?.notifications ?? 0);
          const activityUnreadServerDms = Number(activityCounts?.server_dms ?? 0);

          // Pre-load initial messages for active channel if provided
          let initialMessages: unknown[] = [];
          let initialChannelId: string | undefined;
          let initialHasMore = false;

          if (payload.active_channel_id) {
            const chPermCtx = permCtxMap.get(payload.active_channel_id);
            if (chPermCtx && hasPermission(computePermissions(chPermCtx), Permissions.READ_MESSAGES)) {
              eventDispatcher.subscribe(sessionId, payload.active_channel_id);
              initialChannelId = payload.active_channel_id;

              const msgRows = await d.select().from(messages)
                .where(and(eq(messages.channelId, payload.active_channel_id), eq(messages.deleted, false)))
                .orderBy(desc(messages.id))
                .limit(51);

              initialHasMore = msgRows.length > 50;
              const rows = initialHasMore ? msgRows.slice(0, 50) : msgRows;
              if (rows.length > 0) {
                initialMessages = (await hydrateMessages(d, serverId, user.id, rows)).reverse();
              }
            }
          }

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
              self_member: formattedSelfMember,
              read_states: userReadStates.map(formatReadState),
              presences: [...presences.entries()].map(([uid, p]) => ({
                user_id: uid,
                status: p.status,
                custom_text: p.customText,
                last_active_at: new Date().toISOString(),
              })),
              voice_states: voiceStates.map(formatVoiceState),
              activity_unread_notifications: activityUnreadNotifications,
              activity_unread_server_dms: activityUnreadServerDms,
              initial_messages: initialMessages,
              initial_messages_channel_id: initialChannelId,
              initial_messages_has_more: initialHasMore,
              resume_seq: getCurrentSeq(serverId),
            },
          };
          ws.send(JSON.stringify(ready));

          // Start heartbeat check
          heartbeatTimer = setInterval(() => {
            if (Date.now() - session.lastHeartbeat > HEARTBEAT_TIMEOUT) {
              ws.close(WsCloseCode.SESSION_TIMEOUT, 'Heartbeat timeout');
            }
          }, HEARTBEAT_TIMEOUT);

        } catch (err) {
          console.error('[ws] Identify failed:', err instanceof Error ? err.message : err);
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
          ws.send(JSON.stringify({ event: 'system.resumed', data: { replayed: buffered.length, resume_seq: session.serverId ? getCurrentSeq(session.serverId) : 0 } }));
          break;
        }

        case 'subscribe': {
          const subResult = channelSubSchema.safeParse(msg.data);
          if (subResult.success) {
            const subData = subResult.data;
            try {
              const d = db();
              const sid = await resolveServerId(req);
              const permCtx = await buildPermissionContext(d, sid, session.userId, subData.channel_id);
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
              eventDispatcher.dispatchToChannel(typingData.channel_id, ServerWsEvents.TYPING_START, {
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
            eventDispatcher.dispatchToChannel(stopResult.data.channel_id, ServerWsEvents.TYPING_STOP, {
              channel_id: stopResult.data.channel_id,
              user_id: session.userId,
            });
          }
          break;
        }

        case 'presence.update': {
          const presResult = presenceSchema.safeParse(msg.data);
          if (presResult.success) {
            if (!rateLimiter.check(`presence:${session.userId}`, 1, 5000)) break;
            const presData = presResult.data;
            presenceManager.update(
              session.userId,
              presData.status,
              presData.custom_text ?? null,
            );
            if (session.serverId) {
              eventDispatcher.dispatchToServer(session.serverId, ServerWsEvents.PRESENCE_UPDATE, {
                user_id: session.userId,
                status: presData.status,
                custom_text: presData.custom_text ?? null,
                last_active_at: new Date().toISOString(),
              });
            }
          }
          break;
        }

        case 'server_dm.typing': {
          const dmTypingResult = serverDmTypingSchema.safeParse(msg.data);
          if (dmTypingResult.success) {
            const { conversation_id } = dmTypingResult.data;
            if (rateLimiter.check(`dm_typing:${session.userId}:${conversation_id}`, 1, 3000)) {
              const d = db();
              const dmServerId = await resolveServerId(req);
              if (dmServerId) {
                const [convo] = await d
                  .select()
                  .from(dmConversations)
                  .where(
                    and(
                      eq(dmConversations.id, conversation_id),
                      eq(dmConversations.serverId, dmServerId),
                      or(
                        eq(dmConversations.userA, session.userId),
                        eq(dmConversations.userB, session.userId),
                      ),
                    ),
                  )
                  .limit(1);
                if (convo) {
                  const peerId = convo.userA === session.userId ? convo.userB : convo.userA;
                  eventDispatcher.dispatchToUser(peerId, ServerWsEvents.SERVER_DM_TYPING, {
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
        const closingServerId = session.serverId;

        // Clean up voice state only if THIS session owns it
        if (closingServerId) {
          cleanupVoiceState(closingUserId, closingServerId, sessionId);
        }

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
              if (closingServerId) {
                eventDispatcher.dispatchToServer(closingServerId, ServerWsEvents.PRESENCE_UPDATE, {
                  user_id: closingUserId,
                  status: 'offline',
                  custom_text: null,
                  last_active_at: new Date().toISOString(),
                });
              }
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

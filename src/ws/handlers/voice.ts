import type { WsSession } from '../event-dispatcher.js';
import type { WsMessage } from 'ecto-shared';
import { MAX_VOICE_PARTICIPANTS, Permissions } from 'ecto-shared';
import { voiceStateManager } from '../../services/voice-state.js';
import { voiceManager } from '../../voice/index.js';
import { eventDispatcher } from '../event-dispatcher.js';
import { formatVoiceState } from '../../utils/format.js';
import { buildPermissionContext } from '../../utils/permission-context.js';
import { computePermissions, hasPermission } from 'ecto-shared';
import { db } from '../../db/index.js';
import { channels } from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { voiceJoinSchema, voiceConnectSchema, voiceCapabilitiesSchema, voiceProduceSchema, voiceProducerIdSchema, voiceConsumerIdSchema, voiceMuteSchema, voiceQualitySchema } from '../schemas.js';

export async function handleVoiceMessage(session: WsSession, msg: WsMessage) {
  switch (msg.event) {
    case 'voice.join': {
      const joinResult = voiceJoinSchema.safeParse(msg.data);
      if (!joinResult.success) return;
      const channelId = joinResult.data.channel_id;

      const d = db();
      const sid = session.serverId;
      if (!sid) return;

      // Check channel exists and is voice
      const [channel] = await d
        .select()
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.serverId, sid)))
        .limit(1);
      if (!channel || channel.type !== 'voice') {
        session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 3002, message: 'Cannot connect to this channel' } }));
        return;
      }

      // Check CONNECT_VOICE permission
      const permCtx = await buildPermissionContext(d, sid, session.userId, channelId);
      if (!hasPermission(computePermissions(permCtx), Permissions.CONNECT_VOICE)) {
        session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 5001, message: 'Insufficient permissions' } }));
        return;
      }

      // Check capacity
      if (voiceStateManager.getChannelUserCount(channelId) >= MAX_VOICE_PARTICIPANTS) {
        session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 3003, message: 'Voice channel full' } }));
        return;
      }

      // Already in voice?
      const existing = voiceStateManager.getByUser(session.userId);
      if (existing) {
        if (existing.channelId === channelId && existing.sessionId === session.sessionId) {
          // Same channel, same session — no-op
          return;
        }

        const force = joinResult.data.force === true;
        if (!force) {
          // Respond with already_connected — let client confirm
          session.ws.send(JSON.stringify({
            event: 'voice.already_connected',
            data: {
              channel_id: existing.channelId,
              session_id: existing.sessionId,
              same_session: existing.sessionId === session.sessionId,
            },
          }));
          return;
        }

        // Force: leave current channel
        voiceStateManager.leave(session.userId);
        await voiceManager.leaveChannel(session.userId, existing.channelId);
        eventDispatcher.dispatchToServer(sid, 'voice.state_update', {
          ...formatVoiceState(existing),
          _removed: true,
        });

        // Notify the old session that voice was transferred
        if (existing.sessionId !== session.sessionId) {
          const oldSession = eventDispatcher.getSession(existing.sessionId);
          if (oldSession) {
            oldSession.ws.send(JSON.stringify({
              event: 'voice.transferred',
              data: { channel_id: existing.channelId },
            }));
          }
        }
      }

      // Join
      const state = voiceStateManager.join(session.userId, session.sessionId, channelId);
      console.log(`[voice:debug] user ${session.userId} joining channel ${channelId}`);
      // Get/create mediasoup router + transports
      try {
        const router = await voiceManager.getOrCreateRouter(channelId);
        const transports = await voiceManager.createTransports(channelId, session.userId);
        console.log(`[voice:debug] transports created for ${session.userId}, send ICE candidates:`, JSON.stringify(transports.send.iceCandidates));

        session.ws.send(JSON.stringify({
          event: 'voice.router_capabilities',
          data: { rtpCapabilities: router.rtpCapabilities },
        }));

        session.ws.send(JSON.stringify({
          event: 'voice.transport_created',
          data: {
            send: {
              id: transports.send.id,
              iceParameters: transports.send.iceParameters,
              iceCandidates: transports.send.iceCandidates,
              dtlsParameters: transports.send.dtlsParameters,
            },
            recv: {
              id: transports.recv.id,
              iceParameters: transports.recv.iceParameters,
              iceCandidates: transports.recv.iceCandidates,
              dtlsParameters: transports.recv.dtlsParameters,
            },
          },
        }));

        // Consumers for existing producers are created after the client sends
        // voice.capabilities with its device rtpCapabilities
      } catch (err) {
        session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 8002, message: 'Voice server unavailable' } }));
        voiceStateManager.leave(session.userId);
        return;
      }

      // Broadcast state update
      eventDispatcher.dispatchToServer(sid, 'voice.state_update', formatVoiceState(state));

      // Send existing channel participants to the joining user so they know who's already here
      const channelStates = voiceStateManager.getByChannel(channelId);
      for (const existing of channelStates) {
        if (existing.userId === session.userId) continue;
        session.ws.send(JSON.stringify({
          event: 'voice.state_update',
          data: formatVoiceState(existing),
        }));
      }
      break;
    }

    case 'voice.leave': {
      const state = voiceStateManager.leave(session.userId);
      if (state && session.serverId) {
        await voiceManager.leaveChannel(session.userId, state.channelId);
        eventDispatcher.dispatchToServer(session.serverId, 'voice.state_update', {
          ...formatVoiceState(state),
          _removed: true,
        });
      }
      break;
    }

    case 'voice.connect_transport': {
      const connectResult = voiceConnectSchema.safeParse(msg.data);
      if (connectResult.success) {
        console.log(`[voice:debug] connect_transport: ${connectResult.data.transport_id} for user ${session.userId}`);
        await voiceManager.connectTransport(connectResult.data.transport_id, connectResult.data.dtls_parameters);
        console.log(`[voice:debug] transport connected: ${connectResult.data.transport_id}`);
      }
      break;
    }

    case 'voice.capabilities': {
      const capsResult = voiceCapabilitiesSchema.safeParse(msg.data);
      if (!capsResult.success) break;
      const rtpCapabilities = capsResult.data.rtp_capabilities as object;
      console.log(`[voice:debug] capabilities received from user ${session.userId}`);

      // Now create consumers for existing producers using the client's real capabilities
      const voiceState = voiceStateManager.getByUser(session.userId);

      voiceManager.setDeviceCapabilities(session.userId, rtpCapabilities, voiceState?.channelId);

      if (voiceState) {
        const existingProducers = await voiceManager.getProducersInChannel(voiceState.channelId, session.userId);
        console.log(`[voice:debug] existing producers in channel for ${session.userId}:`, existingProducers.length, existingProducers.map(p => ({ id: p.producerId, kind: p.kind, source: p.source, userId: p.userId })));
        for (const prod of existingProducers) {
          try {
            const consumer = await voiceManager.createConsumer(
              voiceState.channelId,
              session.userId,
              prod.producerId,
              rtpCapabilities,
            );
            if (consumer) {
              console.log(`[voice:debug] consumer created for ${session.userId}: kind=${consumer.kind}, producerId=${prod.producerId}, consumerId=${consumer.consumerId}`);
              eventDispatcher.dispatchToUser(session.userId, 'voice.new_consumer', {
                consumer_id: consumer.consumerId,
                producer_id: prod.producerId,
                user_id: prod.userId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                source: prod.source,
              });
            } else {
              console.log(`[voice:debug] consumer NOT created (canConsume=false) for ${session.userId}, producer ${prod.producerId}`);
            }
          } catch (err) {
            console.warn(`[voice:debug] consumer creation failed for ${session.userId}, producer ${prod.producerId}:`, err);
          }
        }
      }
      break;
    }

    case 'voice.produce': {
      const produceResult = voiceProduceSchema.safeParse(msg.data);
      if (produceResult.success) {
        const { transport_id: transportId, kind, rtp_parameters: rtpParameters, source } = produceResult.data;

        // Check media-type permissions
        const voiceState = voiceStateManager.getByUser(session.userId);
        if (voiceState) {
          const d = db();
          if (session.serverId) {
            const permCtx = await buildPermissionContext(d, session.serverId, session.userId, voiceState.channelId);
            const perms = computePermissions(permCtx);
            const resolvedSource = source ?? (kind === 'audio' ? 'mic' : 'camera');

            if (resolvedSource === 'screen' || resolvedSource === 'screen-audio') {
              if (!hasPermission(perms, Permissions.SCREEN_SHARE)) {
                session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 5001, message: 'You do not have permission to screen share' } }));
                break;
              }
            } else if (kind === 'audio' && !hasPermission(perms, Permissions.SPEAK_VOICE)) {
              session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 5001, message: 'You do not have permission to speak' } }));
              break;
            } else if (kind === 'video' && !hasPermission(perms, Permissions.USE_VIDEO)) {
              session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 5001, message: 'You do not have permission to use video' } }));
              break;
            }
          }
        }

        try {
          const producer = await voiceManager.createProducer(transportId, kind, rtpParameters as object, source);
          console.log(`[voice:debug] producer created: user=${session.userId}, kind=${kind}, source=${source ?? (kind === 'audio' ? 'mic' : 'camera')}, id=${producer.id}`);
          session.ws.send(JSON.stringify({
            event: 'voice.produced',
            data: { producer_id: producer.id },
          }));

          // Notify other users in channel — use their device capabilities
          const state = voiceStateManager.getByUser(session.userId);
          if (state) {
            const channelUsers = voiceStateManager.getByChannel(state.channelId);
            console.log(`[voice:debug] broadcasting new producer to ${channelUsers.length - 1} other users in channel`);
            for (const other of channelUsers) {
              if (other.userId === session.userId) continue;
              const otherCaps = voiceManager.getDeviceCapabilities(other.userId);
              if (!otherCaps) { console.log(`[voice:debug] user ${other.userId} has no device capabilities yet, skipping consumer`); continue; }
              try {
                const consumer = await voiceManager.createConsumer(
                  state.channelId,
                  other.userId,
                  producer.id,
                  otherCaps,
                );
                if (consumer) {
                  console.log(`[voice:debug] consumer created for ${other.userId}: kind=${consumer.kind}, consumerId=${consumer.consumerId}`);
                  eventDispatcher.dispatchToUser(other.userId, 'voice.new_consumer', {
                    consumer_id: consumer.consumerId,
                    producer_id: producer.id,
                    user_id: session.userId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                    source: source ?? (kind === 'audio' ? 'mic' : 'camera'),
                  });
                } else {
                  console.log(`[voice:debug] consumer NOT created for ${other.userId} (canConsume=false)`);
                }
              } catch (err) {
                console.warn(`[voice:debug] consumer creation failed for ${other.userId}:`, err);
              }
            }
          }
        } catch (err) {
          console.error(`[voice:debug] produce failed for user ${session.userId}:`, err);
          session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 8003, message: 'Transport failed' } }));
        }
      }
      break;
    }

    case 'voice.produce_stop': {
      const stopResult = voiceProducerIdSchema.safeParse(msg.data);
      if (stopResult.success) {
        voiceManager.closeProducer(stopResult.data.producer_id);
        const state = voiceStateManager.getByUser(session.userId);
        if (state && session.serverId) {
          eventDispatcher.dispatchToServer(session.serverId, 'voice.producer_closed', {
            producer_id: stopResult.data.producer_id,
            user_id: session.userId,
            channel_id: state.channelId,
          });
        }
      }
      break;
    }

    case 'voice.producer_pause':
    case 'voice.producer_resume': {
      const pauseResult = voiceProducerIdSchema.safeParse(msg.data);
      if (pauseResult.success) {
        if (msg.event === 'voice.producer_pause') {
          voiceManager.pauseProducer(pauseResult.data.producer_id);
        } else {
          voiceManager.resumeProducer(pauseResult.data.producer_id);
        }
      }
      break;
    }

    case 'voice.consumer_resume': {
      const resumeResult = voiceConsumerIdSchema.safeParse(msg.data);
      if (resumeResult.success) {
        await voiceManager.resumeConsumer(resumeResult.data.consumer_id);
      }
      break;
    }

    case 'voice.mute': {
      const muteResult = voiceMuteSchema.safeParse(msg.data);
      if (!muteResult.success) break;
      const { self_mute: selfMute, self_deaf: selfDeaf } = muteResult.data;

      voiceStateManager.updateMute(session.userId, { selfMute, selfDeaf });

      // If self-muting, pause audio producer
      if (selfMute !== undefined) {
        const producers = voiceManager.getUserProducers(session.userId);
        for (const p of producers) {
          if (p.kind === 'audio') {
            if (selfMute) voiceManager.pauseProducer(p.id);
            else voiceManager.resumeProducer(p.id);
          }
        }
      }

      const state = voiceStateManager.getByUser(session.userId);
      if (state && session.serverId) {
        eventDispatcher.dispatchToServer(session.serverId, 'voice.state_update', formatVoiceState(state));
      }
      break;
    }

    case 'voice.set_quality': {
      const qualityResult = voiceQualitySchema.safeParse(msg.data);
      if (qualityResult.success) {
        const { consumer_id, spatial_layer, temporal_layer } = qualityResult.data;
        await voiceManager.setConsumerQuality(consumer_id, spatial_layer, temporal_layer);
      }
      break;
    }
  }
}

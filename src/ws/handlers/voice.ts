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
import { servers, channels } from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';

export async function handleVoiceMessage(session: WsSession, msg: WsMessage) {
  const data = msg.data as Record<string, unknown>;

  switch (msg.event) {
    case 'voice.join': {
      const channelId = data['channel_id'] as string;
      if (!channelId) return;

      const d = db();
      const [server] = await d.select().from(servers).limit(1);
      if (!server) return;

      // Check channel exists and is voice
      const [channel] = await d
        .select()
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.serverId, server.id)))
        .limit(1);
      if (!channel || channel.type !== 'voice') {
        session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 3002, message: 'Cannot connect to this channel' } }));
        return;
      }

      // Check CONNECT_VOICE permission
      const permCtx = await buildPermissionContext(d, server.id, session.userId, channelId);
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
        // Leave current channel first
        voiceStateManager.leave(session.userId);
        await voiceManager.leaveChannel(session.userId);
        eventDispatcher.dispatchToAll('voice.state_update', formatVoiceState(existing));
      }

      // Join
      const state = voiceStateManager.join(session.userId, channelId);
      // Get/create mediasoup router + transports
      try {
        const router = await voiceManager.getOrCreateRouter(channelId);
        const transports = await voiceManager.createTransports(channelId, session.userId);

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

        // Create consumers for existing producers in channel
        const existingProducers = voiceManager.getProducersInChannel(channelId, session.userId);
        for (const prod of existingProducers) {
          try {
            const consumer = await voiceManager.createConsumer(
              channelId,
              session.userId,
              prod.producerId,
              router.rtpCapabilities,
            );
            if (consumer) {
              session.ws.send(JSON.stringify({
                event: 'voice.new_consumer',
                data: {
                  consumer_id: consumer.id,
                  producer_id: prod.producerId,
                  user_id: prod.userId,
                  kind: consumer.kind,
                  rtpParameters: consumer.rtpParameters,
                  source: prod.source,
                },
              }));
            }
          } catch {
            // Consumer creation can fail if capabilities don't match
          }
        }
      } catch (err) {
        session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 8002, message: 'Voice server unavailable' } }));
        voiceStateManager.leave(session.userId);
        return;
      }

      // Broadcast state update
      eventDispatcher.dispatchToAll('voice.state_update', formatVoiceState(state));
      break;
    }

    case 'voice.leave': {
      const state = voiceStateManager.leave(session.userId);
      if (state) {
        await voiceManager.leaveChannel(session.userId);
        eventDispatcher.dispatchToAll('voice.state_update', {
          ...formatVoiceState(state),
          _removed: true,
        });
      }
      break;
    }

    case 'voice.connect_transport': {
      const transportId = data['transport_id'] as string;
      const dtlsParameters = data['dtls_parameters'] as unknown;
      if (transportId && dtlsParameters) {
        await voiceManager.connectTransport(transportId, dtlsParameters);
      }
      break;
    }

    case 'voice.produce': {
      const transportId = data['transport_id'] as string;
      const kind = data['kind'] as 'audio' | 'video';
      const rtpParameters = data['rtp_parameters'] as unknown;
      const source = data['source'] as string | undefined;

      if (transportId && kind && rtpParameters) {
        try {
          const producer = await voiceManager.createProducer(transportId, kind, rtpParameters, source);
          session.ws.send(JSON.stringify({
            event: 'voice.produced',
            data: { producer_id: producer.id },
          }));

          // Notify other users in channel
          const state = voiceStateManager.getByUser(session.userId);
          if (state) {
            const channelUsers = voiceStateManager.getByChannel(state.channelId);
            const router = voiceManager.getRouter(state.channelId);
            for (const other of channelUsers) {
              if (other.userId === session.userId) continue;
              try {
                const consumer = await voiceManager.createConsumer(
                  state.channelId,
                  other.userId,
                  producer.id,
                  router?.rtpCapabilities ?? {} as any,
                );
                if (consumer) {
                  eventDispatcher.dispatchToUser(other.userId, 'voice.new_consumer', {
                    consumer_id: consumer.id,
                    producer_id: producer.id,
                    user_id: session.userId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                    source: source ?? (kind === 'audio' ? 'mic' : 'camera'),
                  });
                }
              } catch {
                // Consumer creation failure
              }
            }
          }
        } catch (err) {
          session.ws.send(JSON.stringify({ event: 'voice.error', data: { code: 8003, message: 'Transport failed' } }));
        }
      }
      break;
    }

    case 'voice.produce_stop': {
      const producerId = data['producer_id'] as string;
      if (producerId) {
        voiceManager.closeProducer(producerId);
        const state = voiceStateManager.getByUser(session.userId);
        if (state) {
          eventDispatcher.dispatchToAll('voice.producer_closed', {
            producer_id: producerId,
            user_id: session.userId,
            channel_id: state.channelId,
          });
        }
      }
      break;
    }

    case 'voice.producer_pause':
    case 'voice.producer_resume': {
      const producerId = data['producer_id'] as string;
      if (producerId) {
        if (msg.event === 'voice.producer_pause') {
          voiceManager.pauseProducer(producerId);
        } else {
          voiceManager.resumeProducer(producerId);
        }
      }
      break;
    }

    case 'voice.consumer_resume': {
      const consumerId = data['consumer_id'] as string;
      if (consumerId) {
        await voiceManager.resumeConsumer(consumerId);
      }
      break;
    }

    case 'voice.mute': {
      const selfMute = data['self_mute'] as boolean | undefined;
      const selfDeaf = data['self_deaf'] as boolean | undefined;

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
      if (state) {
        eventDispatcher.dispatchToAll('voice.state_update', formatVoiceState(state));
      }
      break;
    }

    case 'voice.set_quality': {
      const consumerId = data['consumer_id'] as string;
      const spatialLayer = data['spatial_layer'] as number | undefined;
      const temporalLayer = data['temporal_layer'] as number | undefined;
      if (consumerId) {
        await voiceManager.setConsumerQuality(consumerId, spatialLayer, temporalLayer);
      }
      break;
    }
  }
}

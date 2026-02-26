import { z } from 'zod/v4';

/** Top-level WS message envelope */
export const wsMessageSchema = z.object({
  event: z.string(),
  data: z.unknown(),
  seq: z.number().optional(),
});

/** system.identify payload */
export const identifySchema = z.object({
  token: z.string(),
  protocol_version: z.number().optional(),
  active_channel_id: z.string().uuid().optional(),
});

/** system.resume payload */
export const resumeSchema = z.object({
  session_id: z.string(),
  last_seq: z.number().int(),
});

/** subscribe / unsubscribe payload */
export const channelSubSchema = z.object({
  channel_id: z.string().uuid(),
});

/** typing.start / typing.stop payload */
export const typingSchema = z.object({
  channel_id: z.string().uuid(),
});

/** server_dm.typing payload */
export const serverDmTypingSchema = z.object({
  conversation_id: z.string().uuid(),
});

/** presence.update payload */
export const presenceSchema = z.object({
  status: z.enum(['online', 'idle', 'dnd', 'offline']),
  custom_text: z.string().max(128).nullable().optional(),
});

// ── Voice schemas ──

/** voice.join payload */
export const voiceJoinSchema = z.object({
  channel_id: z.string().uuid(),
  force: z.boolean().optional(),
});

/** voice.connect_transport payload */
export const voiceConnectSchema = z.object({
  transport_id: z.string(),
  dtls_parameters: z.object({
    role: z.enum(['auto', 'client', 'server']).optional(),
    fingerprints: z.array(z.object({
      algorithm: z.string(),
      value: z.string(),
    })),
  }),
});

/** voice.capabilities payload */
export const voiceCapabilitiesSchema = z.object({
  rtp_capabilities: z.unknown(),
});

/** voice.produce payload */
export const voiceProduceSchema = z.object({
  transport_id: z.string(),
  kind: z.enum(['audio', 'video']),
  rtp_parameters: z.unknown(),
  source: z.string().optional(),
});

/** voice.produce_stop / voice.producer_pause / voice.producer_resume payload */
export const voiceProducerIdSchema = z.object({
  producer_id: z.string(),
});

/** voice.consumer_resume payload */
export const voiceConsumerIdSchema = z.object({
  consumer_id: z.string(),
});

/** voice.mute payload */
export const voiceMuteSchema = z.object({
  self_mute: z.boolean().optional(),
  self_deaf: z.boolean().optional(),
});

/** voice.set_quality payload */
export const voiceQualitySchema = z.object({
  consumer_id: z.string(),
  spatial_layer: z.number().int().optional(),
  temporal_layer: z.number().int().optional(),
});

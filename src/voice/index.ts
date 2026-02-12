import * as mediasoup from 'mediasoup';
import type { types as mediasoupTypes } from 'mediasoup';
import os from 'node:os';
import { config } from '../config/index.js';

const MEDIA_CODECS: mediasoupTypes.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: { 'profile-id': 2 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d0032',
      'level-asymmetry-allowed': 1,
    },
  },
];

interface UserTransports {
  send: mediasoupTypes.WebRtcTransport;
  recv: mediasoupTypes.WebRtcTransport;
}

interface ProducerInfo {
  producerId: string;
  userId: string;
  kind: mediasoupTypes.MediaKind;
}

class VoiceManager {
  private workers: mediasoupTypes.Worker[] = [];
  private nextWorkerIdx = 0;

  // channelId → Router
  private routers = new Map<string, mediasoupTypes.Router>();
  // channelId → Set<userId>
  private channelUsers = new Map<string, Set<string>>();
  // `${channelId}:${userId}` → UserTransports
  private transports = new Map<string, UserTransports>();
  // transportId → Transport (for connect/produce lookup)
  private transportById = new Map<string, mediasoupTypes.WebRtcTransport>();
  // transportId → { channelId, userId }
  private transportMeta = new Map<string, { channelId: string; userId: string }>();
  // producerId → Producer
  private producerById = new Map<string, mediasoupTypes.Producer>();
  // producerId → { channelId, userId }
  private producerMeta = new Map<string, { channelId: string; userId: string }>();
  // consumerId → Consumer
  private consumerById = new Map<string, mediasoupTypes.Consumer>();
  // `${channelId}:${userId}` → Consumer[] (consumers this user has)
  private userConsumers = new Map<string, mediasoupTypes.Consumer[]>();

  async initialize(): Promise<void> {
    const numWorkers = Math.max(1, Math.floor(os.cpus().length / 2));
    for (let i = 0; i < numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: config.MEDIASOUP_MIN_PORT,
        rtcMaxPort: config.MEDIASOUP_MAX_PORT,
      });
      worker.on('died', () => {
        console.error(`mediasoup Worker ${worker.pid} died, restarting...`);
        const idx = this.workers.indexOf(worker);
        if (idx !== -1) this.workers.splice(idx, 1);
        // Restart worker
        mediasoup.createWorker({
          logLevel: 'warn',
          rtcMinPort: config.MEDIASOUP_MIN_PORT,
          rtcMaxPort: config.MEDIASOUP_MAX_PORT,
        }).then((w) => {
          this.workers.push(w);
        }).catch((err) => {
          console.error('Failed to restart mediasoup Worker:', err);
        });
      });
      this.workers.push(worker);
    }
    console.log(`mediasoup: ${numWorkers} worker(s) created`);
  }

  private getNextWorker(): mediasoupTypes.Worker {
    const worker = this.workers[this.nextWorkerIdx % this.workers.length];
    if (!worker) throw new Error('No mediasoup workers available');
    this.nextWorkerIdx++;
    return worker;
  }

  async getOrCreateRouter(channelId: string): Promise<mediasoupTypes.Router> {
    const existing = this.routers.get(channelId);
    if (existing && !existing.closed) return existing;

    const worker = this.getNextWorker();
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    this.routers.set(channelId, router);
    return router;
  }

  getRouter(channelId: string): mediasoupTypes.Router | undefined {
    return this.routers.get(channelId);
  }

  async createTransports(channelId: string, userId: string): Promise<UserTransports> {
    const router = this.routers.get(channelId);
    if (!router || router.closed) throw new Error('No router for channel');

    const transportOptions: mediasoupTypes.WebRtcTransportOptions = {
      listenInfos: [{
        protocol: 'udp',
        ip: '0.0.0.0',
        announcedAddress: config.SERVER_ADDRESS,
        portRange: {
          min: config.MEDIASOUP_MIN_PORT,
          max: config.MEDIASOUP_MAX_PORT,
        },
      }, {
        protocol: 'tcp',
        ip: '0.0.0.0',
        announcedAddress: config.SERVER_ADDRESS,
        portRange: {
          min: config.MEDIASOUP_MIN_PORT,
          max: config.MEDIASOUP_MAX_PORT,
        },
      }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    };

    const sendTransport = await router.createWebRtcTransport(transportOptions);
    const recvTransport = await router.createWebRtcTransport(transportOptions);

    const key = `${channelId}:${userId}`;
    const userTransports: UserTransports = { send: sendTransport, recv: recvTransport };
    this.transports.set(key, userTransports);

    this.transportById.set(sendTransport.id, sendTransport);
    this.transportById.set(recvTransport.id, recvTransport);
    this.transportMeta.set(sendTransport.id, { channelId, userId });
    this.transportMeta.set(recvTransport.id, { channelId, userId });

    // Track channel users
    let users = this.channelUsers.get(channelId);
    if (!users) {
      users = new Set();
      this.channelUsers.set(channelId, users);
    }
    users.add(userId);

    return userTransports;
  }

  async connectTransport(transportId: string, dtlsParameters: unknown): Promise<void> {
    const transport = this.transportById.get(transportId);
    if (!transport || transport.closed) return;
    await transport.connect({ dtlsParameters: dtlsParameters as mediasoupTypes.DtlsParameters });
  }

  async createProducer(
    transportId: string,
    kind: mediasoupTypes.MediaKind,
    rtpParameters: unknown,
  ): Promise<mediasoupTypes.Producer> {
    const transport = this.transportById.get(transportId);
    if (!transport || transport.closed) throw new Error('Transport not found or closed');

    const meta = this.transportMeta.get(transportId);
    if (!meta) throw new Error('Transport metadata not found');

    const producer = await transport.produce({
      kind,
      rtpParameters: rtpParameters as mediasoupTypes.RtpParameters,
    });

    this.producerById.set(producer.id, producer);
    this.producerMeta.set(producer.id, { channelId: meta.channelId, userId: meta.userId });

    producer.on('transportclose', () => {
      this.producerById.delete(producer.id);
      this.producerMeta.delete(producer.id);
    });

    return producer;
  }

  async createConsumer(
    channelId: string,
    consumerUserId: string,
    producerId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities,
  ): Promise<mediasoupTypes.Consumer | null> {
    const router = this.routers.get(channelId);
    if (!router || router.closed) return null;

    if (!router.canConsume({ producerId, rtpCapabilities })) return null;

    const key = `${channelId}:${consumerUserId}`;
    const userTransport = this.transports.get(key);
    if (!userTransport) return null;

    const recvTransport = userTransport.recv;
    if (recvTransport.closed) return null;

    const consumer = await recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // Start paused, client resumes after setup
    });

    this.consumerById.set(consumer.id, consumer);

    let consumers = this.userConsumers.get(key);
    if (!consumers) {
      consumers = [];
      this.userConsumers.set(key, consumers);
    }
    consumers.push(consumer);

    consumer.on('transportclose', () => {
      this.consumerById.delete(consumer.id);
      const arr = this.userConsumers.get(key);
      if (arr) {
        const idx = arr.indexOf(consumer);
        if (idx !== -1) arr.splice(idx, 1);
      }
    });

    consumer.on('producerclose', () => {
      this.consumerById.delete(consumer.id);
      const arr = this.userConsumers.get(key);
      if (arr) {
        const idx = arr.indexOf(consumer);
        if (idx !== -1) arr.splice(idx, 1);
      }
    });

    return consumer;
  }

  async resumeConsumer(consumerId: string): Promise<void> {
    const consumer = this.consumerById.get(consumerId);
    if (consumer && !consumer.closed) {
      await consumer.resume();
    }
  }

  async setConsumerQuality(consumerId: string, spatialLayer?: number, temporalLayer?: number): Promise<void> {
    const consumer = this.consumerById.get(consumerId);
    if (!consumer || consumer.closed) return;
    await consumer.setPreferredLayers({
      spatialLayer: spatialLayer ?? 2,
      temporalLayer,
    });
  }

  getProducersInChannel(channelId: string, excludeUserId?: string): ProducerInfo[] {
    const result: ProducerInfo[] = [];
    for (const [producerId, meta] of this.producerMeta) {
      if (meta.channelId !== channelId) continue;
      if (excludeUserId && meta.userId === excludeUserId) continue;
      const producer = this.producerById.get(producerId);
      if (producer && !producer.closed) {
        result.push({
          producerId,
          userId: meta.userId,
          kind: producer.kind,
        });
      }
    }
    return result;
  }

  getUserProducers(userId: string): Array<{ id: string; kind: mediasoupTypes.MediaKind }> {
    const result: Array<{ id: string; kind: mediasoupTypes.MediaKind }> = [];
    for (const [producerId, meta] of this.producerMeta) {
      if (meta.userId !== userId) continue;
      const producer = this.producerById.get(producerId);
      if (producer && !producer.closed) {
        result.push({ id: producer.id, kind: producer.kind });
      }
    }
    return result;
  }

  closeProducer(producerId: string): void {
    const producer = this.producerById.get(producerId);
    if (producer && !producer.closed) {
      producer.close();
    }
    this.producerById.delete(producerId);
    this.producerMeta.delete(producerId);
  }

  pauseProducer(producerId: string): void {
    const producer = this.producerById.get(producerId);
    if (producer && !producer.closed && !producer.paused) {
      producer.pause().catch(() => {});
    }
  }

  resumeProducer(producerId: string): void {
    const producer = this.producerById.get(producerId);
    if (producer && !producer.closed && producer.paused) {
      producer.resume().catch(() => {});
    }
  }

  async leaveChannel(userId: string): Promise<void> {
    // Find all channels the user is in and clean up
    for (const [key, userTransports] of this.transports) {
      if (!key.endsWith(`:${userId}`)) continue;
      const channelId = key.split(':')[0]!;

      // Close all producers for this user in this channel
      for (const [producerId, meta] of this.producerMeta) {
        if (meta.channelId === channelId && meta.userId === userId) {
          this.closeProducer(producerId);
        }
      }

      // Close all consumers for this user
      const consumers = this.userConsumers.get(key);
      if (consumers) {
        for (const consumer of consumers) {
          if (!consumer.closed) consumer.close();
          this.consumerById.delete(consumer.id);
        }
        this.userConsumers.delete(key);
      }

      // Close transports
      if (!userTransports.send.closed) userTransports.send.close();
      if (!userTransports.recv.closed) userTransports.recv.close();

      this.transportById.delete(userTransports.send.id);
      this.transportById.delete(userTransports.recv.id);
      this.transportMeta.delete(userTransports.send.id);
      this.transportMeta.delete(userTransports.recv.id);

      this.transports.delete(key);

      // Remove user from channel
      const users = this.channelUsers.get(channelId);
      if (users) {
        users.delete(userId);
        if (users.size === 0) {
          this.channelUsers.delete(channelId);
          // Destroy router if no users left
          const router = this.routers.get(channelId);
          if (router && !router.closed) {
            router.close();
          }
          this.routers.delete(channelId);
        }
      }
    }
  }

  close(): void {
    for (const worker of this.workers) {
      worker.close();
    }
    this.workers = [];
    this.routers.clear();
    this.channelUsers.clear();
    this.transports.clear();
    this.transportById.clear();
    this.transportMeta.clear();
    this.producerById.clear();
    this.producerMeta.clear();
    this.consumerById.clear();
    this.userConsumers.clear();
  }
}

export const voiceManager = new VoiceManager();

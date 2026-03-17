/**
 * Per-server ring buffer of recent WS events for resume support.
 * Stores the last MAX_EVENTS events with monotonic sequence numbers.
 * This enables cross-session resume: a client that reconnects with a new
 * WebSocket session can receive missed events without a full system.ready.
 */
const MAX_EVENTS = 500;
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

interface BufferedEvent {
  seq: number;
  event: string;
  data: unknown;
  timestamp: number;
}

const serverBuffers = new Map<string, {
  events: BufferedEvent[];
  nextSeq: number;
}>();

export function pushEvent(serverId: string, event: string, data: unknown): number {
  let buf = serverBuffers.get(serverId);
  if (!buf) {
    buf = { events: [], nextSeq: 1 };
    serverBuffers.set(serverId, buf);
  }
  const seq = buf.nextSeq++;
  buf.events.push({ seq, event, data, timestamp: Date.now() });
  // Trim old events
  while (buf.events.length > MAX_EVENTS) {
    buf.events.shift();
  }
  return seq;
}

export function getEventsSince(serverId: string, seq: number): BufferedEvent[] | null {
  const buf = serverBuffers.get(serverId);
  if (!buf || buf.events.length === 0) return null;

  const oldest = buf.events[0];
  if (!oldest || seq < oldest.seq) return null; // Too old, need full resync

  // Check age — prune expired events
  const cutoff = Date.now() - MAX_AGE_MS;
  while (buf.events.length > 0 && buf.events[0]!.timestamp < cutoff) {
    buf.events.shift();
  }
  if (buf.events.length === 0 || seq < (buf.events[0]?.seq ?? 0)) return null;

  const startIdx = buf.events.findIndex(e => e.seq > seq);
  if (startIdx === -1) return []; // Client is up to date
  return buf.events.slice(startIdx);
}

export function getCurrentSeq(serverId: string): number {
  const buf = serverBuffers.get(serverId);
  return buf ? buf.nextSeq - 1 : 0;
}

export function clearServerBuffer(serverId: string): void {
  serverBuffers.delete(serverId);
}

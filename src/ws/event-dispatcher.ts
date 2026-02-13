import type { WebSocket } from 'ws';
import type { WsMessage } from 'ecto-shared';

export interface WsSession {
  sessionId: string;
  userId: string;
  ws: WebSocket;
  subscribedChannels: Set<string>;
  seq: number;
  eventBuffer: { seq: number; event: string; data: unknown; timestamp: number }[];
  authenticated: boolean;
  lastHeartbeat: number;
}

const BUFFER_TTL = 5 * 60 * 1000; // 5 minutes

class EventDispatcher {
  sessions = new Map<string, WsSession>();
  userSessions = new Map<string, Set<string>>();
  private channelSessions = new Map<string, Set<string>>();

  addSession(sessionId: string, userId: string, ws: WebSocket): WsSession {
    const session: WsSession = {
      sessionId,
      userId,
      ws,
      subscribedChannels: new Set(),
      seq: 0,
      eventBuffer: [],
      authenticated: true,
      lastHeartbeat: Date.now(),
    };
    this.sessions.set(sessionId, session);

    const userSet = this.userSessions.get(userId) ?? new Set();
    userSet.add(sessionId);
    this.userSessions.set(userId, userSet);

    return session;
  }

  removeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Clean up channel index
    for (const channelId of session.subscribedChannels) {
      const channelSet = this.channelSessions.get(channelId);
      if (channelSet) {
        channelSet.delete(sessionId);
        if (channelSet.size === 0) this.channelSessions.delete(channelId);
      }
    }

    this.sessions.delete(sessionId);
    const userSet = this.userSessions.get(session.userId);
    if (userSet) {
      userSet.delete(sessionId);
      if (userSet.size === 0) this.userSessions.delete(session.userId);
    }
  }

  subscribe(sessionId: string, channelId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribedChannels.add(channelId);
      let channelSet = this.channelSessions.get(channelId);
      if (!channelSet) {
        channelSet = new Set();
        this.channelSessions.set(channelId, channelSet);
      }
      channelSet.add(sessionId);
    }
  }

  unsubscribe(sessionId: string, channelId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribedChannels.delete(channelId);
      const channelSet = this.channelSessions.get(channelId);
      if (channelSet) {
        channelSet.delete(sessionId);
        if (channelSet.size === 0) this.channelSessions.delete(channelId);
      }
    }
  }

  private send(session: WsSession, event: string, data: unknown) {
    session.seq++;
    const msg: WsMessage = { event, data, seq: session.seq };

    session.eventBuffer.push({ seq: session.seq, event, data, timestamp: Date.now() });
    // Trim old buffer entries
    const cutoff = Date.now() - BUFFER_TTL;
    session.eventBuffer = session.eventBuffer.filter((e) => e.timestamp > cutoff);

    if (session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify(msg));
    }
  }

  dispatchToChannel(channelId: string, event: string, data: unknown) {
    const sessionIds = this.channelSessions.get(channelId);
    if (!sessionIds) return;
    for (const sid of sessionIds) {
      const session = this.sessions.get(sid);
      if (session?.authenticated) {
        this.send(session, event, data);
      }
    }
  }

  dispatchToAll(event: string, data: unknown) {
    for (const session of this.sessions.values()) {
      if (session.authenticated) {
        this.send(session, event, data);
      }
    }
  }

  dispatchToUser(userId: string, event: string, data: unknown) {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return;
    for (const sid of sessionIds) {
      const session = this.sessions.get(sid);
      if (session?.authenticated) {
        this.send(session, event, data);
      }
    }
  }

  getEventBuffer(sessionId: string, afterSeq: number): { seq: number; event: string; data: unknown }[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.eventBuffer.filter((e) => e.seq > afterSeq);
  }

  disconnectUser(userId: string, closeCode: number, reason: string) {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return;
    for (const sid of sessionIds) {
      const session = this.sessions.get(sid);
      if (session) {
        session.ws.close(closeCode, reason);
        this.removeSession(sid);
      }
    }
  }

  getSession(sessionId: string): WsSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionsByUser(userId: string): WsSession[] {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return [];
    const result: WsSession[] = [];
    for (const sid of sessionIds) {
      const session = this.sessions.get(sid);
      if (session) result.push(session);
    }
    return result;
  }
}

export const eventDispatcher = new EventDispatcher();

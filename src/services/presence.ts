import type { PresenceStatus } from 'ecto-shared';

export interface IPresenceManager {
  update(userId: string, status: PresenceStatus, customText: string | null): void;
  get(userId: string): { status: PresenceStatus; customText: string | null; lastActiveAt: Date } | null;
  remove(userId: string): void;
  getOnlineCount(): number;
  getOnlineUserIds(): string[];
  getAllForMembers(userIds: string[]): Map<string, { status: PresenceStatus; customText: string | null }>;
}

export class MemoryPresenceManager implements IPresenceManager {
  private presences = new Map<string, { status: PresenceStatus; customText: string | null; lastActiveAt: Date }>();

  update(userId: string, status: PresenceStatus, customText: string | null) {
    this.presences.set(userId, { status, customText, lastActiveAt: new Date() });
  }

  get(userId: string) {
    return this.presences.get(userId) ?? null;
  }

  remove(userId: string) {
    this.presences.delete(userId);
  }

  getOnlineCount(): number {
    let count = 0;
    for (const p of this.presences.values()) {
      if (p.status !== 'offline') count++;
    }
    return count;
  }

  getOnlineUserIds(): string[] {
    const ids: string[] = [];
    for (const [userId, p] of this.presences) {
      if (p.status !== 'offline') ids.push(userId);
    }
    return ids;
  }

  getAllForMembers(userIds: string[]): Map<string, { status: PresenceStatus; customText: string | null }> {
    const result = new Map<string, { status: PresenceStatus; customText: string | null }>();
    for (const id of userIds) {
      const p = this.presences.get(id);
      if (p) {
        result.set(id, { status: p.status, customText: p.customText });
      }
    }
    return result;
  }
}

let _presenceManager: IPresenceManager = new MemoryPresenceManager();

export function setPresenceManager(impl: IPresenceManager) {
  _presenceManager = impl;
}

export const presenceManager: IPresenceManager = new Proxy({} as IPresenceManager, {
  get(_target, prop) {
    return (_presenceManager as any)[prop];
  },
});

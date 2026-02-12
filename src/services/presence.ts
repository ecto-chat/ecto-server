import type { PresenceStatus } from 'ecto-shared';

export class PresenceManager {
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

export const presenceManager = new PresenceManager();

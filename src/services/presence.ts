import type { PresenceStatus } from 'ecto-shared';

export class PresenceManager {
  private presences = new Map<string, { status: PresenceStatus; customText: string | null }>();

  update(_userId: string, _status: PresenceStatus, _customText: string | null) {
    // TODO
  }

  get(userId: string) {
    return this.presences.get(userId) ?? null;
  }
}

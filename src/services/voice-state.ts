export interface VoiceStateData {
  userId: string;
  sessionId: string;
  channelId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  videoEnabled: boolean;
  connectedAt: string;
}

export class VoiceStateManager {
  private states = new Map<string, VoiceStateData>();

  join(userId: string, sessionId: string, channelId: string): VoiceStateData {
    const state: VoiceStateData = {
      userId,
      sessionId,
      channelId,
      selfMute: false,
      selfDeaf: false,
      serverMute: false,
      serverDeaf: false,
      videoEnabled: false,
      connectedAt: new Date().toISOString(),
    };
    this.states.set(userId, state);
    return state;
  }

  leave(userId: string): VoiceStateData | null {
    const state = this.states.get(userId) ?? null;
    this.states.delete(userId);
    return state;
  }

  updateMute(
    userId: string,
    updates: { selfMute?: boolean; selfDeaf?: boolean; serverMute?: boolean; serverDeaf?: boolean; videoEnabled?: boolean },
  ) {
    const state = this.states.get(userId);
    if (!state) return;
    if (updates.selfMute !== undefined) state.selfMute = updates.selfMute;
    if (updates.selfDeaf !== undefined) state.selfDeaf = updates.selfDeaf;
    if (updates.serverMute !== undefined) state.serverMute = updates.serverMute;
    if (updates.serverDeaf !== undefined) state.serverDeaf = updates.serverDeaf;
    if (updates.videoEnabled !== undefined) state.videoEnabled = updates.videoEnabled;
  }

  getByUser(userId: string): VoiceStateData | null {
    return this.states.get(userId) ?? null;
  }

  getByChannel(channelId: string): VoiceStateData[] {
    const result: VoiceStateData[] = [];
    for (const state of this.states.values()) {
      if (state.channelId === channelId) result.push(state);
    }
    return result;
  }

  getAllStates(): VoiceStateData[] {
    return [...this.states.values()];
  }

  getChannelUserCount(channelId: string): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.channelId === channelId) count++;
    }
    return count;
  }
}

export const voiceStateManager = new VoiceStateManager();

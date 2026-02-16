import { voiceStateManager } from '../services/voice-state.js';
import { voiceManager } from '../voice/index.js';
import { eventDispatcher } from '../ws/event-dispatcher.js';
import { formatVoiceState } from './format.js';

/**
 * Clean up voice state for a user. If sessionId is provided, only clean up
 * if the voice state belongs to that specific session.
 */
export function cleanupVoiceState(userId: string, sessionId?: string) {
  const voiceState = voiceStateManager.getByUser(userId);
  if (!voiceState) return;
  if (sessionId && voiceState.sessionId !== sessionId) return;

  voiceStateManager.leave(userId);
  voiceManager.leaveChannel(userId).catch(() => {});
  eventDispatcher.dispatchToAll('voice.state_update', {
    ...formatVoiceState(voiceState),
    _removed: true,
  });
}

import type { HostingMode } from 'ecto-shared';
import { config } from '../config/index.js';
import { setPresenceManager, MemoryPresenceManager, type IPresenceManager } from './presence.js';
import { setVoiceStateManager, MemoryVoiceStateManager, type IVoiceStateManager } from './voice-state.js';
import { setEventDispatcher, MemoryEventDispatcher, type IEventDispatcher } from '../ws/event-dispatcher.js';
import { setVoiceManager, type IVoiceManager } from '../voice/index.js';
import { setRateLimiter, MemoryRateLimiter, type IRateLimiter } from '../middleware/rate-limit.js';
import { setFileStorage, type IFileStorage } from './file-storage.js';

export interface ServiceOverrides {
  presenceManager?: IPresenceManager;
  voiceStateManager?: IVoiceStateManager;
  eventDispatcher?: IEventDispatcher;
  voiceManager?: IVoiceManager;
  rateLimiter?: IRateLimiter;
  fileStorage?: IFileStorage;
}

/**
 * Initialize all service implementations.
 *
 * In self-hosted mode (default), uses in-memory implementations.
 * In managed mode, accepts injected implementations (e.g., Redis-backed)
 * from ecto-gateway.
 */
export function initializeServices(overrides?: ServiceOverrides): void {
  if (overrides?.presenceManager) {
    setPresenceManager(overrides.presenceManager);
  }
  if (overrides?.voiceStateManager) {
    setVoiceStateManager(overrides.voiceStateManager);
  }
  if (overrides?.eventDispatcher) {
    setEventDispatcher(overrides.eventDispatcher);
  }
  if (overrides?.voiceManager) {
    setVoiceManager(overrides.voiceManager);
  }
  if (overrides?.rateLimiter) {
    setRateLimiter(overrides.rateLimiter);
  }
  if (overrides?.fileStorage) {
    setFileStorage(overrides.fileStorage);
  }

  console.log(`Services initialized (mode: ${config.HOSTING_MODE})`);
}

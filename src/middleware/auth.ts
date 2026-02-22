import { verifyServerToken } from '../utils/jwt.js';
import { centralVerifyToken } from '../services/central-client.js';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { cachedProfiles } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

export interface AuthUser {
  id: string;
  identity_type: 'global' | 'local';
}

/** Cache profile from central verification result */
function cacheProfile(result: { user_id: string; username: string; discriminator: string; display_name: string | null; avatar_url: string | null }): void {
  const d = db();
  d.insert(cachedProfiles)
    .values({
      userId: result.user_id,
      username: result.username,
      discriminator: result.discriminator,
      displayName: result.display_name,
      avatarUrl: result.avatar_url,
    })
    .onConflictDoUpdate({
      target: cachedProfiles.userId,
      set: {
        username: result.username,
        discriminator: result.discriminator,
        displayName: result.display_name,
        avatarUrl: result.avatar_url,
        fetchedAt: new Date(),
      },
    })
    .catch(() => {});
}

export async function verifyToken(token: string): Promise<AuthUser> {
  // Always try server-issued JWT first (server.join issues these even in managed mode)
  try {
    const payload = await verifyServerToken(token);

    // Central JWTs may pass server verification if secrets are shared,
    // but they lack identity_type. Fall through to central verification in that case.
    if (payload.identity_type) {
      // In managed mode, ensure the profile is cached from central.
      if (config.HOSTING_MODE === 'managed' && config.CENTRAL_URL) {
        centralVerifyToken(token).then(cacheProfile).catch(() => {});
      }

      return { id: payload.sub, identity_type: payload.identity_type };
    }
  } catch {
    // Not a server token — try central
  }

  // In managed mode with local accounts disabled, only accept central tokens
  if (config.HOSTING_MODE === 'managed' && !config.ALLOW_LOCAL_ACCOUNTS) {
    if (!config.CENTRAL_URL) {
      throw new Error('Managed mode requires CENTRAL_URL');
    }
    const result = await centralVerifyToken(token);
    await cacheProfile(result);
    return { id: result.user_id, identity_type: 'global' };
  }

  // Try central verification if configured
  if (config.CENTRAL_URL) {
    const result = await centralVerifyToken(token);
    await cacheProfile(result);
    return { id: result.user_id, identity_type: 'global' };
  }

  throw new Error('Authentication failed');
}

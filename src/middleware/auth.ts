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

export async function verifyToken(token: string): Promise<AuthUser> {
  // Try server-issued JWT first
  try {
    const payload = await verifyServerToken(token);
    return { id: payload.sub, identity_type: payload.identity_type };
  } catch {
    // Not a server token — try central
  }

  // Try central verification if configured
  if (config.CENTRAL_URL) {
    const result = await centralVerifyToken(token);

    // Cache the profile
    const d = db();
    await d
      .insert(cachedProfiles)
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
      });

    return { id: result.user_id, identity_type: 'global' };
  }

  throw new Error('Authentication failed');
}

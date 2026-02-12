import type { Db } from '../db/index.js';
import { cachedProfiles, localUsers } from '../db/schema/index.js';
import { eq, inArray } from 'drizzle-orm';

export interface ResolvedProfile {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  discriminator?: string;
}

export async function resolveUserProfile(
  d: Db,
  userId: string,
  identityType: 'global' | 'local',
): Promise<ResolvedProfile> {
  if (identityType === 'local') {
    const [local] = await d
      .select()
      .from(localUsers)
      .where(eq(localUsers.id, userId))
      .limit(1);
    if (local) {
      return {
        username: local.username,
        display_name: local.displayName,
        avatar_url: local.avatarUrl,
      };
    }
  } else {
    const [profile] = await d
      .select()
      .from(cachedProfiles)
      .where(eq(cachedProfiles.userId, userId))
      .limit(1);
    if (profile) {
      return {
        username: profile.username,
        display_name: profile.displayName,
        avatar_url: profile.avatarUrl,
        discriminator: profile.discriminator,
      };
    }
  }

  return { username: 'Unknown', display_name: null, avatar_url: null };
}

export async function resolveUserProfiles(
  d: Db,
  userIds: string[],
): Promise<Map<string, ResolvedProfile>> {
  const result = new Map<string, ResolvedProfile>();
  if (userIds.length === 0) return result;

  const uniqueIds = [...new Set(userIds)];

  // Batch query both tables
  const [globalProfiles, localProfiles] = await Promise.all([
    d.select().from(cachedProfiles).where(inArray(cachedProfiles.userId, uniqueIds)),
    d.select().from(localUsers).where(inArray(localUsers.id, uniqueIds)),
  ]);

  for (const p of globalProfiles) {
    result.set(p.userId, {
      username: p.username,
      display_name: p.displayName,
      avatar_url: p.avatarUrl,
      discriminator: p.discriminator,
    });
  }

  for (const p of localProfiles) {
    if (!result.has(p.id)) {
      result.set(p.id, {
        username: p.username,
        display_name: p.displayName,
        avatar_url: p.avatarUrl,
      });
    }
  }

  return result;
}

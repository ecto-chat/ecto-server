import type { Db } from '../db/index.js';
import type { PermissionContext } from 'ecto-shared';
import { computePermissions, hasPermission, Permissions } from 'ecto-shared';
import {
  members,
  roles,
  memberRoles,
  channelPermissionOverrides,
  categoryPermissionOverrides,
  channels,
  servers,
} from '../db/schema/index.js';
import { eq, and, inArray } from 'drizzle-orm';
import { ectoError } from './errors.js';

export async function buildPermissionContext(
  d: Db,
  serverId: string,
  userId: string,
  channelId?: string,
): Promise<PermissionContext> {
  // Get server to check owner
  const [server] = await d
    .select({ adminUserId: servers.adminUserId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  const isOwner = server?.adminUserId === userId;

  // Get member
  const [member] = await d
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);

  if (!member) {
    return {
      isOwner: false,
      everyonePermissions: 0,
      rolePermissions: [],
    };
  }

  // Get all server roles
  const allRoles = await d
    .select()
    .from(roles)
    .where(eq(roles.serverId, serverId));

  const everyoneRole = allRoles.find((r) => r.isDefault);
  const everyonePermissions = everyoneRole?.permissions ?? 0;

  // Get member's role assignments
  const memberRoleRows = await d
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(eq(memberRoles.memberId, member.id));

  const memberRoleIds = new Set(memberRoleRows.map((r) => r.roleId));
  const rolePermissions = allRoles
    .filter((r) => memberRoleIds.has(r.id) && !r.isDefault)
    .map((r) => r.permissions);

  const ctx: PermissionContext = {
    isOwner,
    everyonePermissions,
    rolePermissions,
  };

  // Channel + category overrides
  if (channelId) {
    // Look up channel's category
    const [ch] = await d
      .select({ categoryId: channels.categoryId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    // Fetch category overrides if channel belongs to a category
    if (ch?.categoryId) {
      const catOverrides = await d
        .select()
        .from(categoryPermissionOverrides)
        .where(eq(categoryPermissionOverrides.categoryId, ch.categoryId));

      const catEveryoneOverride = everyoneRole
        ? catOverrides.find((o) => o.targetType === 'role' && o.targetId === everyoneRole.id)
        : undefined;
      if (catEveryoneOverride) {
        ctx.categoryEveryoneOverride = { allow: catEveryoneOverride.allow, deny: catEveryoneOverride.deny };
      }

      const catRoleOverrides = catOverrides
        .filter((o) => o.targetType === 'role' && memberRoleIds.has(o.targetId))
        .map((o) => ({ allow: o.allow, deny: o.deny }));
      if (catRoleOverrides.length > 0) {
        ctx.categoryRoleOverrides = catRoleOverrides;
      }
    }

    // Channel overrides
    const overrides = await d
      .select()
      .from(channelPermissionOverrides)
      .where(eq(channelPermissionOverrides.channelId, channelId));

    const everyoneOverride = everyoneRole
      ? overrides.find((o) => o.targetType === 'role' && o.targetId === everyoneRole.id)
      : undefined;
    if (everyoneOverride) {
      ctx.everyoneOverride = { allow: everyoneOverride.allow, deny: everyoneOverride.deny };
    }

    const roleOverrides = overrides
      .filter((o) => o.targetType === 'role' && memberRoleIds.has(o.targetId))
      .map((o) => ({ allow: o.allow, deny: o.deny }));
    if (roleOverrides.length > 0) {
      ctx.roleOverrides = roleOverrides;
    }

    const memberOverride = overrides.find(
      (o) => o.targetType === 'member' && o.targetId === userId,
    );
    if (memberOverride) {
      ctx.memberOverride = { allow: memberOverride.allow, deny: memberOverride.deny };
    }
  }

  return ctx;
}

/**
 * Build permission contexts for ALL channels in a server at once.
 * Uses 4 queries total instead of 4-6 per channel.
 */
export async function buildBatchPermissionContext(
  d: Db,
  serverId: string,
  userId: string,
  channelIds: string[],
): Promise<Map<string, PermissionContext>> {
  // 1. Get server owner
  const [server] = await d
    .select({ adminUserId: servers.adminUserId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  const isOwner = server?.adminUserId === userId;

  // 2. Get member
  const [member] = await d
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);

  if (!member) {
    // Not a member — no permissions for any channel
    const empty: PermissionContext = { isOwner: false, everyonePermissions: 0, rolePermissions: [] };
    return new Map(channelIds.map((id) => [id, empty]));
  }

  // 3. Get all roles, member role assignments, channel overrides, and channel→category mapping in parallel
  const [allRoles, memberRoleRows, allOverrides, allChannels] = await Promise.all([
    d.select().from(roles).where(eq(roles.serverId, serverId)),
    d.select({ roleId: memberRoles.roleId }).from(memberRoles).where(eq(memberRoles.memberId, member.id)),
    channelIds.length > 0
      ? d.select().from(channelPermissionOverrides).where(inArray(channelPermissionOverrides.channelId, channelIds))
      : Promise.resolve([]),
    channelIds.length > 0
      ? d.select({ id: channels.id, categoryId: channels.categoryId }).from(channels).where(inArray(channels.id, channelIds))
      : Promise.resolve([]),
  ]);

  const everyoneRole = allRoles.find((r) => r.isDefault);
  const everyonePermissions = everyoneRole?.permissions ?? 0;

  const memberRoleIds = new Set(memberRoleRows.map((r) => r.roleId));
  const rolePermissions = allRoles
    .filter((r) => memberRoleIds.has(r.id) && !r.isDefault)
    .map((r) => r.permissions);

  // Build channel → categoryId mapping
  const channelCategoryMap = new Map<string, string>();
  const uniqueCategoryIds = new Set<string>();
  for (const ch of allChannels) {
    if (ch.categoryId) {
      channelCategoryMap.set(ch.id, ch.categoryId);
      uniqueCategoryIds.add(ch.categoryId);
    }
  }

  // Batch-fetch category overrides
  type CatOverrideRow = typeof categoryPermissionOverrides.$inferSelect;
  const catOverridesByCategory = new Map<string, CatOverrideRow[]>();
  if (uniqueCategoryIds.size > 0) {
    const allCatOverrides = await d
      .select()
      .from(categoryPermissionOverrides)
      .where(inArray(categoryPermissionOverrides.categoryId, [...uniqueCategoryIds]));
    for (const o of allCatOverrides) {
      const arr = catOverridesByCategory.get(o.categoryId) ?? [];
      arr.push(o);
      catOverridesByCategory.set(o.categoryId, arr);
    }
  }

  // Group channel overrides by channel
  const overridesByChannel = new Map<string, typeof allOverrides>();
  for (const o of allOverrides) {
    const arr = overridesByChannel.get(o.channelId) ?? [];
    arr.push(o);
    overridesByChannel.set(o.channelId, arr);
  }

  // 4. Build per-channel contexts
  const result = new Map<string, PermissionContext>();
  for (const channelId of channelIds) {
    const ctx: PermissionContext = { isOwner, everyonePermissions, rolePermissions };

    // Category overrides
    const categoryId = channelCategoryMap.get(channelId);
    if (categoryId) {
      const catOverrides = catOverridesByCategory.get(categoryId) ?? [];

      const catEveryoneOverride = everyoneRole
        ? catOverrides.find((o) => o.targetType === 'role' && o.targetId === everyoneRole.id)
        : undefined;
      if (catEveryoneOverride) {
        ctx.categoryEveryoneOverride = { allow: catEveryoneOverride.allow, deny: catEveryoneOverride.deny };
      }

      const catRoleOvr = catOverrides
        .filter((o) => o.targetType === 'role' && memberRoleIds.has(o.targetId))
        .map((o) => ({ allow: o.allow, deny: o.deny }));
      if (catRoleOvr.length > 0) {
        ctx.categoryRoleOverrides = catRoleOvr;
      }
    }

    // Channel overrides
    const overrides = overridesByChannel.get(channelId) ?? [];

    const everyoneOverride = everyoneRole
      ? overrides.find((o) => o.targetType === 'role' && o.targetId === everyoneRole.id)
      : undefined;
    if (everyoneOverride) {
      ctx.everyoneOverride = { allow: everyoneOverride.allow, deny: everyoneOverride.deny };
    }

    const roleOvr = overrides
      .filter((o) => o.targetType === 'role' && memberRoleIds.has(o.targetId))
      .map((o) => ({ allow: o.allow, deny: o.deny }));
    if (roleOvr.length > 0) {
      ctx.roleOverrides = roleOvr;
    }

    const memberOverride = overrides.find((o) => o.targetType === 'member' && o.targetId === userId);
    if (memberOverride) {
      ctx.memberOverride = { allow: memberOverride.allow, deny: memberOverride.deny };
    }

    result.set(channelId, ctx);
  }

  return result;
}

/**
 * Returns the set of user_ids who have READ_MESSAGES on a given channel.
 * Evaluates permissions for ALL server members against one channel.
 */
export async function getChannelVisibleUserIds(
  d: Db,
  serverId: string,
  channelId: string,
): Promise<Set<string>> {
  // 1. Get server owner
  const [server] = await d
    .select({ adminUserId: servers.adminUserId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  // 2. Get all roles, all members with role assignments, channel info, and channel overrides in parallel
  const [allRoles, allMembers, allMemberRoleRows, [channel], channelOverrides] = await Promise.all([
    d.select().from(roles).where(eq(roles.serverId, serverId)),
    d.select({ id: members.id, userId: members.userId }).from(members).where(eq(members.serverId, serverId)),
    d.select({ memberId: memberRoles.memberId, roleId: memberRoles.roleId }).from(memberRoles)
      .innerJoin(members, eq(members.id, memberRoles.memberId))
      .where(eq(members.serverId, serverId)),
    d.select({ categoryId: channels.categoryId }).from(channels).where(eq(channels.id, channelId)).limit(1),
    d.select().from(channelPermissionOverrides).where(eq(channelPermissionOverrides.channelId, channelId)),
  ]);

  // 3. Fetch category overrides if channel belongs to a category
  type CatOverrideRow = typeof categoryPermissionOverrides.$inferSelect;
  let catOverrides: CatOverrideRow[] = [];
  if (channel?.categoryId) {
    catOverrides = await d
      .select()
      .from(categoryPermissionOverrides)
      .where(eq(categoryPermissionOverrides.categoryId, channel.categoryId));
  }

  const everyoneRole = allRoles.find((r) => r.isDefault);
  const everyonePermissions = everyoneRole?.permissions ?? 0;

  // Build memberId → roleIds map
  const rolesByMember = new Map<string, Set<string>>();
  for (const mr of allMemberRoleRows) {
    const set = rolesByMember.get(mr.memberId) ?? new Set();
    set.add(mr.roleId);
    rolesByMember.set(mr.memberId, set);
  }

  // Role id → permissions lookup
  const roleMap = new Map(allRoles.map((r) => [r.id, r]));

  // Pre-compute category overrides by target
  const catEveryoneOverride = everyoneRole
    ? catOverrides.find((o) => o.targetType === 'role' && o.targetId === everyoneRole.id)
    : undefined;

  // Channel overrides by target
  const chEveryoneOverride = everyoneRole
    ? channelOverrides.find((o) => o.targetType === 'role' && o.targetId === everyoneRole.id)
    : undefined;

  // Member-specific channel overrides: targetId (userId) → override
  const memberOverridesMap = new Map<string, { allow: number; deny: number }>();
  for (const o of channelOverrides) {
    if (o.targetType === 'member') {
      memberOverridesMap.set(o.targetId, { allow: o.allow, deny: o.deny });
    }
  }

  const visibleUserIds = new Set<string>();

  for (const member of allMembers) {
    // Owner always visible
    if (server?.adminUserId === member.userId) {
      visibleUserIds.add(member.userId);
      continue;
    }

    const memberRoleIds = rolesByMember.get(member.id) ?? new Set();
    const rolePermissions = allRoles
      .filter((r) => memberRoleIds.has(r.id) && !r.isDefault)
      .map((r) => r.permissions);

    const ctx: PermissionContext = {
      isOwner: false,
      everyonePermissions,
      rolePermissions,
    };

    // Category overrides
    if (catEveryoneOverride) {
      ctx.categoryEveryoneOverride = { allow: catEveryoneOverride.allow, deny: catEveryoneOverride.deny };
    }
    const catRoleOvr = catOverrides
      .filter((o) => o.targetType === 'role' && memberRoleIds.has(o.targetId))
      .map((o) => ({ allow: o.allow, deny: o.deny }));
    if (catRoleOvr.length > 0) {
      ctx.categoryRoleOverrides = catRoleOvr;
    }

    // Channel overrides
    if (chEveryoneOverride) {
      ctx.everyoneOverride = { allow: chEveryoneOverride.allow, deny: chEveryoneOverride.deny };
    }
    const chRoleOvr = channelOverrides
      .filter((o) => o.targetType === 'role' && memberRoleIds.has(o.targetId))
      .map((o) => ({ allow: o.allow, deny: o.deny }));
    if (chRoleOvr.length > 0) {
      ctx.roleOverrides = chRoleOvr;
    }

    const memberOverride = memberOverridesMap.get(member.userId);
    if (memberOverride) {
      ctx.memberOverride = memberOverride;
    }

    const effective = computePermissions(ctx);
    if (hasPermission(effective, Permissions.READ_MESSAGES)) {
      visibleUserIds.add(member.userId);
    }
  }

  return visibleUserIds;
}

export async function requirePermission(
  d: Db,
  serverId: string,
  userId: string,
  permission: number,
  channelId?: string,
) {
  const ctx = await buildPermissionContext(d, serverId, userId, channelId);
  const effective = computePermissions(ctx);
  if (!hasPermission(effective, permission)) {
    throw ectoError('FORBIDDEN', 5001, 'Insufficient permissions');
  }
}

export async function requireMember(
  d: Db,
  serverId: string,
  userId: string,
  tokenVersion?: number,
) {
  const [member] = await d
    .select()
    .from(members)
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);

  if (!member) {
    throw ectoError('FORBIDDEN', 2002, 'Not a member of this server');
  }

  // Check token version if provided (lenient for old tokens without tv)
  if (tokenVersion !== undefined && member.tokenVersion !== tokenVersion) {
    throw ectoError('UNAUTHORIZED', 1008, 'Token has been revoked');
  }

  return member;
}

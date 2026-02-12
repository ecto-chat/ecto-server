import type { Db } from '../db/index.js';
import type { PermissionContext } from 'ecto-shared';
import { computePermissions, hasPermission } from 'ecto-shared';
import {
  members,
  roles,
  memberRoles,
  channelPermissionOverrides,
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

  // Channel overrides
  if (channelId) {
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
) {
  const [member] = await d
    .select()
    .from(members)
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);

  if (!member) {
    throw ectoError('FORBIDDEN', 2002, 'Not a member of this server');
  }

  return member;
}

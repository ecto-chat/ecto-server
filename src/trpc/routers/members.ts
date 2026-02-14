import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { members, memberRoles, roles, bans, messages, servers } from '../../db/schema/index.js';
import { eq, and, count, ilike, or, lt, desc, inArray, sql } from 'drizzle-orm';
import { generateUUIDv7, Permissions } from 'ecto-shared';
import { formatMember } from '../../utils/format.js';
import { requirePermission, requireMember, buildPermissionContext } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { resolveUserProfiles } from '../../utils/resolve-profile.js';
import { voiceStateManager } from '../../services/voice-state.js';
import { formatVoiceState } from '../../utils/format.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';
import { voiceManager } from '../../voice/index.js';
import { presenceManager } from '../../services/presence.js';

/** Clean up voice, presence, and WS sessions for a user being removed from the server */
function cleanupAndDisconnect(userId: string, closeCode: number, reason: string) {
  // Voice cleanup (must happen before removeSession)
  const voiceState = voiceStateManager.getByUser(userId);
  if (voiceState) {
    voiceStateManager.leave(userId);
    voiceManager.leaveChannel(userId).catch(() => {});
    eventDispatcher.dispatchToAll('voice.state_update', {
      ...formatVoiceState(voiceState),
      _removed: true,
    });
  }

  // Presence cleanup
  presenceManager.update(userId, 'offline', null);
  eventDispatcher.dispatchToAll('presence.update', {
    user_id: userId,
    status: 'offline',
    custom_text: null,
    last_active_at: new Date().toISOString(),
  });

  // Close WS + remove sessions
  eventDispatcher.disconnectUser(userId, closeCode, reason);
}

async function getHighestRolePosition(d: typeof import('../../db/index.js').db extends () => infer R ? R : never, serverId: string, userId: string): Promise<number> {
  const [member] = await d
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);
  if (!member) return -1;

  const memberRoleRows = await d
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(eq(memberRoles.memberId, member.id));

  if (memberRoleRows.length === 0) return 0;

  const roleIds = memberRoleRows.map((r) => r.roleId);
  const roleRows = await d
    .select({ position: roles.position })
    .from(roles)
    .where(inArray(roles.id, roleIds));

  return Math.max(...roleRows.map((r) => r.position), 0);
}

async function checkHierarchy(d: typeof import('../../db/index.js').db extends () => infer R ? R : never, serverId: string, actorId: string, targetUserId: string) {
  // Server owner bypasses hierarchy
  const [server] = await d
    .select({ adminUserId: servers.adminUserId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (server?.adminUserId === actorId) return;

  const actorPos = await getHighestRolePosition(d, serverId, actorId);
  const targetPos = await getHighestRolePosition(d, serverId, targetUserId);

  if (actorPos <= targetPos) {
    throw ectoError('FORBIDDEN', 5004, 'Role hierarchy violation');
  }
}

export const membersRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().uuid().optional(),
        role_id: z.string().uuid().optional(),
        search: z.string().max(100).optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      const d = ctx.db;
      const limit = input?.limit ?? 50;

      // Build query conditions
      const conditions = [eq(members.serverId, ctx.serverId)];
      if (input?.after) {
        conditions.push(lt(members.id, input.after));
      }

      let query = d.select().from(members).where(and(...conditions)).orderBy(desc(members.id)).limit(limit + 1);

      let memberRows = await query;

      // Filter by role
      if (input?.role_id) {
        const roleMembers = await d
          .select({ memberId: memberRoles.memberId })
          .from(memberRoles)
          .where(eq(memberRoles.roleId, input.role_id));
        const memberIdSet = new Set(roleMembers.map((r) => r.memberId));
        memberRows = memberRows.filter((m) => memberIdSet.has(m.id));
      }

      // Resolve profiles
      const userIds = memberRows.map((m) => m.userId);
      const profiles = await resolveUserProfiles(d, userIds);

      // Filter by search
      if (input?.search) {
        const search = input.search.toLowerCase();
        memberRows = memberRows.filter((m) => {
          const profile = profiles.get(m.userId);
          const username = profile?.username?.toLowerCase() ?? '';
          const nickname = m.nickname?.toLowerCase() ?? '';
          return username.includes(search) || nickname.includes(search);
        });
      }

      const has_more = memberRows.length > limit;
      if (has_more) memberRows = memberRows.slice(0, limit);

      // Get role IDs per member
      const memberIds = memberRows.map((m) => m.id);
      const allMemberRoles = memberIds.length > 0
        ? await d.select().from(memberRoles).where(inArray(memberRoles.memberId, memberIds))
        : [];

      const rolesByMember = new Map<string, string[]>();
      for (const mr of allMemberRoles) {
        const arr = rolesByMember.get(mr.memberId) ?? [];
        arr.push(mr.roleId);
        rolesByMember.set(mr.memberId, arr);
      }

      // Get total count
      const [totalResult] = await d
        .select({ count: count() })
        .from(members)
        .where(eq(members.serverId, ctx.serverId));

      const formattedMembers = memberRows.map((m) => {
        const profile = profiles.get(m.userId) ?? { username: 'Unknown', display_name: null, avatar_url: null };
        const roleIds = rolesByMember.get(m.id) ?? [];
        return formatMember(m, profile, roleIds);
      });

      return { members: formattedMembers, total: totalResult?.count ?? 0, has_more };
    }),

  kick: protectedProcedure
    .input(z.object({ user_id: z.string().uuid(), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.KICK_MEMBERS);
      await checkHierarchy(ctx.db, ctx.serverId, ctx.user.id, input.user_id);

      const target = await requireMember(ctx.db, ctx.serverId, input.user_id);
      await ctx.db.delete(members).where(eq(members.id, target.id));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'member.kick',
        targetType: 'member',
        targetId: input.user_id,
        details: { reason: input.reason },
      });

      eventDispatcher.dispatchToAll('member.leave', { user_id: input.user_id });
      cleanupAndDisconnect(input.user_id, 4003, 'Kicked');
      return { success: true };
    }),

  ban: protectedProcedure
    .input(
      z.object({
        user_id: z.string().uuid(),
        reason: z.string().max(500).optional(),
        delete_messages: z.enum(['1h', '24h', '7d']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.BAN_MEMBERS);
      await checkHierarchy(ctx.db, ctx.serverId, ctx.user.id, input.user_id);
      const d = ctx.db;

      // Insert ban
      await d.insert(bans).values({
        id: generateUUIDv7(),
        serverId: ctx.serverId,
        userId: input.user_id,
        bannedBy: ctx.user.id,
        reason: input.reason ?? null,
      });

      // Soft-delete recent messages if requested
      if (input.delete_messages) {
        const since: Record<string, number> = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
        const ms = since[input.delete_messages] ?? 0;
        if (ms > 0) {
          const cutoff = new Date(Date.now() - ms);
          await d
            .update(messages)
            .set({ deleted: true })
            .where(
              and(
                eq(messages.authorId, input.user_id),
                sql`${messages.createdAt} > ${cutoff}`,
              ),
            );
        }
      }

      // Remove member
      const [target] = await d
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, input.user_id)))
        .limit(1);
      if (target) {
        await d.delete(members).where(eq(members.id, target.id));
      }

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'member.ban',
        targetType: 'member',
        targetId: input.user_id,
        details: { reason: input.reason, delete_messages: input.delete_messages },
      });

      eventDispatcher.dispatchToAll('member.leave', { user_id: input.user_id });
      cleanupAndDisconnect(input.user_id, 4003, 'Banned');
      return { success: true };
    }),

  unban: protectedProcedure
    .input(z.object({ user_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.BAN_MEMBERS);

      await ctx.db
        .delete(bans)
        .where(and(eq(bans.serverId, ctx.serverId), eq(bans.userId, input.user_id)));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'member.unban',
        targetType: 'member',
        targetId: input.user_id,
      });

      return { success: true };
    }),

  updateRoles: protectedProcedure
    .input(z.object({ user_id: z.string().uuid(), role_ids: z.array(z.string().uuid()) }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_ROLES);
      const d = ctx.db;

      const target = await requireMember(d, ctx.serverId, input.user_id);

      // Delete old non-default roles
      await d.delete(memberRoles).where(eq(memberRoles.memberId, target.id));

      // Always include @everyone
      const [defaultRole] = await d
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.serverId, ctx.serverId), eq(roles.isDefault, true)))
        .limit(1);

      const allRoleIds = defaultRole ? [defaultRole.id, ...input.role_ids.filter((id) => id !== defaultRole.id)] : input.role_ids;

      if (allRoleIds.length > 0) {
        await d.insert(memberRoles).values(allRoleIds.map((roleId) => ({ memberId: target.id, roleId })));
      }

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'member.roles_update',
        targetType: 'member',
        targetId: input.user_id,
        details: { role_ids: input.role_ids },
      });

      // Re-fetch member
      const [memberRow] = await d.select().from(members).where(eq(members.id, target.id)).limit(1);
      const profile = (await resolveUserProfiles(d, [input.user_id])).get(input.user_id) ?? { username: 'Unknown', display_name: null, avatar_url: null };
      const formatted = formatMember(memberRow!, profile, allRoleIds);
      eventDispatcher.dispatchToAll('member.update', formatted);
      return formatted;
    }),

  updateNickname: protectedProcedure
    .input(z.object({ user_id: z.string().uuid(), nickname: z.string().max(64).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;

      // Self or MANAGE_ROLES
      if (input.user_id !== ctx.user.id) {
        await requirePermission(d, ctx.serverId, ctx.user.id, Permissions.MANAGE_ROLES);
      }

      const target = await requireMember(d, ctx.serverId, input.user_id);
      await d.update(members).set({ nickname: input.nickname ?? null }).where(eq(members.id, target.id));

      const [memberRow] = await d.select().from(members).where(eq(members.id, target.id)).limit(1);
      const profile = (await resolveUserProfiles(d, [input.user_id])).get(input.user_id) ?? { username: 'Unknown', display_name: null, avatar_url: null };
      const mrRows = await d.select({ roleId: memberRoles.roleId }).from(memberRoles).where(eq(memberRoles.memberId, target.id));
      const formatted = formatMember(memberRow!, profile, mrRows.map((r) => r.roleId));
      eventDispatcher.dispatchToAll('member.update', formatted);
      return formatted;
    }),

  voiceMute: protectedProcedure
    .input(
      z.object({
        user_id: z.string().uuid(),
        server_mute: z.boolean().optional(),
        server_deaf: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.server_mute !== undefined) {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MUTE_MEMBERS);
      }
      if (input.server_deaf !== undefined) {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.DEAFEN_MEMBERS);
      }
      await checkHierarchy(ctx.db, ctx.serverId, ctx.user.id, input.user_id);

      const state = voiceStateManager.getByUser(input.user_id);
      if (!state) throw ectoError('NOT_FOUND', 8000, 'User is not in a voice channel');

      voiceStateManager.updateMute(input.user_id, {
        serverMute: input.server_mute,
        serverDeaf: input.server_deaf,
      });

      const updated = voiceStateManager.getByUser(input.user_id)!;
      const formatted = formatVoiceState(updated);
      eventDispatcher.dispatchToAll('voice.state_update', formatted);
      return formatted;
    }),

  updateDmPreference: protectedProcedure
    .input(z.object({ allow_dms: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const member = await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      await ctx.db.update(members).set({ allowDms: input.allow_dms }).where(eq(members.id, member.id));
      return { success: true };
    }),
});

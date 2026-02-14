import { z } from 'zod/v4';
import { router, publicProcedure, protectedProcedure } from '../init.js';
import {
  servers,
  members,
  memberRoles,
  roles,
  invites,
  bans,
  channels,
  serverConfig,
  dmConversations,
} from '../../db/schema/index.js';
import { eq, and, count, sql } from 'drizzle-orm';
import {
  generateUUIDv7,
  Permissions,
  updateServerSchema,
} from 'ecto-shared';
import { formatServer, formatMember, formatChannel } from '../../utils/format.js';
import { requirePermission, requireMember } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';
import { signServerToken } from '../../utils/jwt.js';
import { registerLocal, loginLocal } from './local-auth.js';
import { resolveUserProfile, resolveUserProfiles } from '../../utils/resolve-profile.js';
import { presenceManager } from '../../services/presence.js';

export const serverRouter = router({
  info: publicProcedure
    .input(z.object({ invite_code: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const d = ctx.db;
      const [[server], [srvConfig]] = await Promise.all([
        d.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1),
        d.select().from(serverConfig).where(eq(serverConfig.serverId, ctx.serverId)).limit(1),
      ]);
      if (!server) throw ectoError('NOT_FOUND', 2000, 'Server not found');

      const [memberCount] = await d
        .select({ count: count() })
        .from(members)
        .where(eq(members.serverId, ctx.serverId));

      const onlineCount = presenceManager.getOnlineCount();

      const result: {
        server: ReturnType<typeof formatServer>;
        member_count: number;
        online_count: number;
        channels?: ReturnType<typeof formatChannel>[];
      } = {
        server: formatServer(server, srvConfig),
        member_count: memberCount?.count ?? 0,
        online_count: onlineCount,
      };

      // If authenticated and a member, include channels
      if (ctx.user) {
        const [member] = await d
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, ctx.user.id)))
          .limit(1);

        if (member) {
          const channelRows = await d
            .select()
            .from(channels)
            .where(eq(channels.serverId, ctx.serverId));
          result.channels = channelRows.map(formatChannel);
        }
      }

      return result;
    }),

  update: protectedProcedure
    .input(updateServerSchema)
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_SERVER);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) updates['name'] = input.name;
      if (input.description !== undefined) updates['description'] = input.description;
      if (input.icon_url !== undefined) updates['iconUrl'] = input.icon_url;

      await ctx.db.update(servers).set(updates).where(eq(servers.id, ctx.serverId));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'server.update',
        targetType: 'server',
        targetId: ctx.serverId,
        details: input as Record<string, unknown>,
      });

      const [updated] = await ctx.db
        .select()
        .from(servers)
        .where(eq(servers.id, ctx.serverId))
        .limit(1);
      return formatServer(updated!);
    }),

  join: publicProcedure
    .input(
      z
        .object({
          invite_code: z.string().optional(),
          username: z.string().min(1).max(32).optional(),
          password: z.string().min(8).max(128).optional(),
          action: z.enum(['register', 'login']).optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;

      // 1. Determine identity
      let userId: string;
      let identityType: 'global' | 'local';

      if (ctx.user) {
        userId = ctx.user.id;
        identityType = ctx.user.identity_type;
      } else if (input?.username && input?.password) {
        // Local account
        const [sConfig] = await d
          .select()
          .from(serverConfig)
          .where(eq(serverConfig.serverId, ctx.serverId))
          .limit(1);

        if (!sConfig?.allowLocalAccounts) {
          throw ectoError('FORBIDDEN', 1006, 'Local accounts are disabled');
        }

        if (input.action === 'login') {
          const local = await loginLocal(d, { username: input.username, password: input.password });
          userId = local.id;
        } else {
          const local = await registerLocal(d, { username: input.username, password: input.password });
          userId = local.id;
        }
        identityType = 'local';
      } else {
        throw ectoError('UNAUTHORIZED', 1000, 'Authentication required');
      }

      // 2. Check not already a member
      const [existingMember] = await d
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, userId)))
        .limit(1);

      if (existingMember) {
        // Already a member — re-issue a server token
        const serverToken = await signServerToken({ sub: userId, identity_type: identityType });
        const profile = await resolveUserProfile(d, userId, identityType);
        const memberRoleRows = await d
          .select({ roleId: memberRoles.roleId })
          .from(memberRoles)
          .where(eq(memberRoles.memberId, existingMember.id));
        const roleIds = memberRoleRows.map((r) => r.roleId);
        const [memberRow] = await d.select().from(members).where(eq(members.id, existingMember.id)).limit(1);
        const [serverRow] = await d.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);

        return {
          server_token: serverToken,
          server: formatServer(serverRow!),
          member: formatMember(memberRow!, profile, roleIds),
        };
      }

      // 3. Check not banned
      const [ban] = await d
        .select({ id: bans.id })
        .from(bans)
        .where(and(eq(bans.serverId, ctx.serverId), eq(bans.userId, userId)))
        .limit(1);

      if (ban) throw ectoError('FORBIDDEN', 2003, 'You are banned from this server');

      // 4. Check invite requirement
      const [sConfig] = await d
        .select()
        .from(serverConfig)
        .where(eq(serverConfig.serverId, ctx.serverId))
        .limit(1);

      if (sConfig?.requireInvite) {
        if (!input?.invite_code) throw ectoError('FORBIDDEN', 2004, 'Invite code required');

        const [invite] = await d
          .select()
          .from(invites)
          .where(and(eq(invites.serverId, ctx.serverId), eq(invites.code, input.invite_code)))
          .limit(1);

        if (!invite) throw ectoError('NOT_FOUND', 2004, 'Invalid invite code');
        if (invite.revoked) throw ectoError('FORBIDDEN', 2004, 'Invite has been revoked');
        if (invite.expiresAt && invite.expiresAt < new Date()) throw ectoError('FORBIDDEN', 2005, 'Invite has expired');
        if (invite.maxUses && invite.useCount >= invite.maxUses) throw ectoError('FORBIDDEN', 2006, 'Invite has reached max uses');

        await d.update(invites).set({ useCount: invite.useCount + 1 }).where(eq(invites.id, invite.id));
      }

      // 5. If no members exist yet, make this user the server owner
      const [existingMemberCount] = await d
        .select({ count: sql<number>`count(*)::int` })
        .from(members)
        .where(eq(members.serverId, ctx.serverId));

      if (existingMemberCount && existingMemberCount.count === 0) {
        await d
          .update(servers)
          .set({ adminUserId: userId })
          .where(eq(servers.id, ctx.serverId));
      }

      // 6. Create member
      const memberId = generateUUIDv7();
      await d.insert(members).values({ id: memberId, serverId: ctx.serverId, userId, identityType });

      // 7. Assign @everyone role
      const [defaultRole] = await d
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.serverId, ctx.serverId), eq(roles.isDefault, true)))
        .limit(1);

      if (defaultRole) {
        await d.insert(memberRoles).values({ memberId, roleId: defaultRole.id });
      }

      // 7. Sign server token
      const serverToken = await signServerToken({ sub: userId, identity_type: identityType });

      // 8. Get member data
      const [memberRow] = await d.select().from(members).where(eq(members.id, memberId)).limit(1);
      const profile = await resolveUserProfile(d, userId, identityType);
      const roleIds = defaultRole ? [defaultRole.id] : [];

      const [serverRow] = await d.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);

      const memberFormatted = formatMember(memberRow!, profile, roleIds);
      eventDispatcher.dispatchToAll('member.join', memberFormatted);

      return {
        server_token: serverToken,
        server: formatServer(serverRow!),
        member: memberFormatted,
      };
    }),

  leave: protectedProcedure.mutation(async ({ ctx }) => {
    const d = ctx.db;

    const [server] = await d
      .select({ adminUserId: servers.adminUserId })
      .from(servers)
      .where(eq(servers.id, ctx.serverId))
      .limit(1);

    if (server?.adminUserId === ctx.user.id) {
      throw ectoError('FORBIDDEN', 5001, 'Server owner cannot leave');
    }

    const member = await requireMember(d, ctx.serverId, ctx.user.id);
    await d.delete(members).where(eq(members.id, member.id));
    eventDispatcher.dispatchToAll('member.leave', { user_id: ctx.user.id });
    return { success: true };
  }),

  delete: protectedProcedure
    .input(z.object({ confirmation: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [server] = await d.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);

      if (!server) throw ectoError('NOT_FOUND', 2000, 'Server not found');
      if (server.adminUserId !== ctx.user.id) throw ectoError('FORBIDDEN', 5001, 'Only the server owner can delete the server');
      if (input.confirmation !== server.name) throw ectoError('BAD_REQUEST', 2000, 'Confirmation must match server name');

      await d.delete(servers).where(eq(servers.id, ctx.serverId));
      return { success: true };
    }),

  uploadIcon: protectedProcedure
    .input(z.object({ icon_url: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_SERVER);
      await ctx.db.update(servers).set({ iconUrl: input.icon_url, updatedAt: new Date() }).where(eq(servers.id, ctx.serverId));
      return { icon_url: input.icon_url, sizes: {} as Record<string, string> };
    }),

  dms: router({
    open: protectedProcedure
      .input(z.object({ user_id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx.db, ctx.serverId, ctx.user.id);
        const d = ctx.db;

        const [userA, userB] =
          ctx.user.id < input.user_id ? [ctx.user.id, input.user_id] : [input.user_id, ctx.user.id];

        const [existing] = await d
          .select()
          .from(dmConversations)
          .where(
            and(
              eq(dmConversations.serverId, ctx.serverId),
              eq(dmConversations.userA, userA),
              eq(dmConversations.userB, userB),
            ),
          )
          .limit(1);

        if (existing) return { conversation_id: existing.id, created: false };

        const id = generateUUIDv7();
        await d.insert(dmConversations).values({ id, serverId: ctx.serverId, userA, userB });
        return { conversation_id: id, created: true };
      }),

    list: protectedProcedure.query(async ({ ctx }) => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      const d = ctx.db;

      const conversations = await d
        .select()
        .from(dmConversations)
        .where(
          and(
            eq(dmConversations.serverId, ctx.serverId),
            sql`(${dmConversations.userA} = ${ctx.user.id} OR ${dmConversations.userB} = ${ctx.user.id})`,
          ),
        );

      const otherUserIds = conversations.map((c) => (c.userA === ctx.user.id ? c.userB : c.userA));
      const profiles = await resolveUserProfiles(d, otherUserIds);

      return conversations.map((c) => {
        const otherId = c.userA === ctx.user.id ? c.userB : c.userA;
        const profile = profiles.get(otherId);
        return {
          user_id: otherId,
          username: profile?.username ?? 'Unknown',
          discriminator: profile?.discriminator ?? '0000',
          display_name: profile?.display_name ?? null,
          avatar_url: profile?.avatar_url ?? null,
          last_message: null,
          unread_count: 0,
        };
      });
    }),
  }),
});

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
  messages,
} from '../../db/schema/index.js';
import { eq, and, count, sql } from 'drizzle-orm';
import {
  generateUUIDv7,
  Permissions,
  updateServerSchema,
  MessageType,
} from 'ecto-shared';
import { formatServer, formatMember, formatChannel, formatMessage, formatMessageAuthor } from '../../utils/format.js';
import { requirePermission, requireMember } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';
import { cleanupVoiceState } from '../../utils/voice-cleanup.js';
import { signServerToken } from '../../utils/jwt.js';
import { registerLocal, loginLocal } from './local-auth.js';
import { cleanupMemberData } from './members.js';
import { resolveUserProfile, resolveUserProfiles } from '../../utils/resolve-profile.js';
import { voiceStateManager } from '../../services/voice-state.js';
import { WsCloseCode } from 'ecto-shared';
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
        require_invite: boolean;
        allow_local_accounts: boolean;
        channels?: ReturnType<typeof formatChannel>[];
      } = {
        server: formatServer(server, srvConfig),
        member_count: memberCount?.count ?? 0,
        online_count: onlineCount,
        require_invite: srvConfig?.requireInvite ?? false,
        allow_local_accounts: srvConfig?.allowLocalAccounts ?? true,
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
      if (input.banner_url !== undefined) updates['bannerUrl'] = input.banner_url;
      if (input.default_channel_id !== undefined) updates['defaultChannelId'] = input.default_channel_id;

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
      const formatted = formatServer(updated!);
      eventDispatcher.dispatchToServer(ctx.serverId, 'server.update', formatted);
      return formatted;
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

      // 1. Determine identity (before transaction — local auth may need its own writes)
      let userId: string;
      let identityType: 'global' | 'local';

      if (ctx.user) {
        userId = ctx.user.id;
        identityType = ctx.user.identity_type;
      } else if (input?.username && input?.password) {
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

      // 2. Everything else in a transaction
      const result = await d.transaction(async (tx) => {
        // Check not already a member
        const [existingMember] = await tx
          .select({ id: members.id, tokenVersion: members.tokenVersion })
          .from(members)
          .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, userId)))
          .limit(1);

        if (existingMember) {
          const serverToken = await signServerToken({ sub: userId, identity_type: identityType, tv: existingMember.tokenVersion, serverId: ctx.serverId });
          const profile = await resolveUserProfile(tx, userId, identityType);
          const memberRoleRows = await tx
            .select({ roleId: memberRoles.roleId })
            .from(memberRoles)
            .where(eq(memberRoles.memberId, existingMember.id));
          const roleIds = memberRoleRows.map((r) => r.roleId);
          const [memberRow] = await tx.select().from(members).where(eq(members.id, existingMember.id)).limit(1);
          const [serverRow] = await tx.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);

          return {
            server_token: serverToken,
            server: formatServer(serverRow!),
            member: formatMember(memberRow!, profile, roleIds),
            isNew: false as const,
          };
        }

        // Check not banned
        const [ban] = await tx
          .select({ id: bans.id })
          .from(bans)
          .where(and(eq(bans.serverId, ctx.serverId), eq(bans.userId, userId)))
          .limit(1);

        if (ban) throw ectoError('FORBIDDEN', 2003, 'You are banned from this server');

        // Check invite requirement
        const [sConfig] = await tx
          .select()
          .from(serverConfig)
          .where(eq(serverConfig.serverId, ctx.serverId))
          .limit(1);

        if (sConfig?.requireInvite) {
          if (!input?.invite_code) throw ectoError('FORBIDDEN', 2004, 'Invite code required');

          const [invite] = await tx
            .select()
            .from(invites)
            .where(and(eq(invites.serverId, ctx.serverId), eq(invites.code, input.invite_code)))
            .limit(1);

          if (!invite) throw ectoError('NOT_FOUND', 2004, 'Invalid invite code');
          if (invite.revoked) throw ectoError('FORBIDDEN', 2004, 'Invite has been revoked');
          if (invite.expiresAt && invite.expiresAt < new Date()) throw ectoError('FORBIDDEN', 2005, 'Invite has expired');
          if (invite.maxUses && invite.useCount >= invite.maxUses) throw ectoError('FORBIDDEN', 2006, 'Invite has reached max uses');

          await tx.update(invites).set({ useCount: invite.useCount + 1 }).where(eq(invites.id, invite.id));
        }

        // If no members exist yet, make this user the server owner
        const [existingMemberCount] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(members)
          .where(eq(members.serverId, ctx.serverId));

        if (existingMemberCount && existingMemberCount.count === 0) {
          await tx
            .update(servers)
            .set({ adminUserId: userId })
            .where(eq(servers.id, ctx.serverId));
        }

        // Create member
        const memberId = generateUUIDv7();
        await tx.insert(members).values({ id: memberId, serverId: ctx.serverId, userId, identityType });

        // Assign @everyone role
        const [defaultRole] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.serverId, ctx.serverId), eq(roles.isDefault, true)))
          .limit(1);

        if (defaultRole) {
          await tx.insert(memberRoles).values({ memberId, roleId: defaultRole.id });
        }

        // Sign server token
        const serverToken = await signServerToken({ sub: userId, identity_type: identityType, tv: 0, serverId: ctx.serverId });

        // Get member data
        const [memberRow] = await tx.select().from(members).where(eq(members.id, memberId)).limit(1);
        const profile = await resolveUserProfile(tx, userId, identityType);
        const roleIds = defaultRole ? [defaultRole.id] : [];
        const [serverRow] = await tx.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);

        return {
          server_token: serverToken,
          server: formatServer(serverRow!),
          member: formatMember(memberRow!, profile, roleIds),
          isNew: true as const,
        };
      });

      // Broadcast after transaction commits
      if (result.isNew) {
        eventDispatcher.dispatchToServer(ctx.serverId, 'member.join', result.member);

        // Insert MEMBER_JOIN system message in the default channel
        const [[srvCfg], [srv]] = await Promise.all([
          d.select().from(serverConfig).where(eq(serverConfig.serverId, ctx.serverId)).limit(1),
          d.select({ defaultChannelId: servers.defaultChannelId }).from(servers).where(eq(servers.id, ctx.serverId)).limit(1),
        ]);

        if (srvCfg?.showSystemMessages && srv?.defaultChannelId) {
          const sysId = generateUUIDv7();
          await d.insert(messages).values({
            id: sysId,
            channelId: srv.defaultChannelId,
            authorId: userId,
            content: null,
            type: MessageType.MEMBER_JOIN,
          });
          const [sysRow] = await d.select().from(messages).where(eq(messages.id, sysId)).limit(1);
          if (sysRow) {
            const profile = (await resolveUserProfiles(d, [userId])).get(userId) ?? { username: 'Unknown', display_name: null, avatar_url: null };
            const [memberRow] = await d
              .select({ nickname: members.nickname })
              .from(members)
              .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, userId)))
              .limit(1);
            const author = formatMessageAuthor(profile, userId, memberRow?.nickname ?? null);
            const sysFormatted = formatMessage(sysRow, author, [], []);
            eventDispatcher.dispatchToChannel(srv.defaultChannelId, 'message.create', sysFormatted);
          }
        }
      }

      return {
        server_token: result.server_token,
        server: result.server,
        member: result.member,
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

    // Clean up voice state before removing member
    cleanupVoiceState(ctx.user.id, ctx.serverId);

    // Clean up read states and DM data
    await cleanupMemberData(d, ctx.serverId, ctx.user.id);

    await d.delete(members).where(eq(members.id, member.id));

    await insertAuditLog(d, {
      serverId: ctx.serverId,
      actorId: ctx.user.id,
      action: 'member.leave',
      targetType: 'member',
      targetId: ctx.user.id,
    });

    eventDispatcher.dispatchToServer(ctx.serverId, 'member.leave', { user_id: ctx.user.id });
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

      // Clean up all voice states before deleting
      for (const state of voiceStateManager.getAllStates()) {
        cleanupVoiceState(state.userId, ctx.serverId);
      }

      // Broadcast server deletion so clients disconnect
      eventDispatcher.dispatchToServer(ctx.serverId, 'server.delete', { id: ctx.serverId });

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'server.delete',
        targetType: 'server',
        targetId: ctx.serverId,
        details: { name: server.name },
      });

      await d.delete(servers).where(eq(servers.id, ctx.serverId));

      // Disconnect all clients
      eventDispatcher.disconnectAll(WsCloseCode.SERVER_SHUTTING_DOWN, 'Server deleted');

      return { success: true };
    }),

  transferOwnership: protectedProcedure
    .input(z.object({
      new_owner_id: z.string().uuid(),
      confirmation: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [server] = await d.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);

      if (!server) throw ectoError('NOT_FOUND', 2000, 'Server not found');
      if (server.adminUserId !== ctx.user.id) throw ectoError('FORBIDDEN', 5001, 'Only the server owner can transfer ownership');
      if (input.confirmation !== server.name) throw ectoError('BAD_REQUEST', 2000, 'Confirmation must match server name');

      // Verify new owner is a member with a global account
      const [newOwnerMember] = await d
        .select()
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, input.new_owner_id)))
        .limit(1);

      if (!newOwnerMember) throw ectoError('NOT_FOUND', 2000, 'User is not a member of this server');

      await d.update(servers).set({ adminUserId: input.new_owner_id, updatedAt: new Date() }).where(eq(servers.id, ctx.serverId));

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'server.transfer_ownership',
        targetType: 'member',
        targetId: input.new_owner_id,
        details: { previous_owner: ctx.user.id },
      });

      const [updated] = await d.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);
      const formatted = formatServer(updated!);
      eventDispatcher.dispatchToServer(ctx.serverId, 'server.update', formatted);
      return { success: true };
    }),

  refreshToken: protectedProcedure.mutation(async ({ ctx }) => {
    const d = ctx.db;
    const member = await requireMember(d, ctx.serverId, ctx.user.id);

    const [server] = await d
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, ctx.serverId))
      .limit(1);

    const serverToken = await signServerToken({
      sub: ctx.user.id,
      identity_type: ctx.user.identity_type,
      tv: member.tokenVersion,
      serverId: server?.id,
    });

    return { server_token: serverToken };
  }),

  uploadIcon: protectedProcedure
    .input(z.object({ icon_url: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_SERVER);
      await ctx.db.update(servers).set({ iconUrl: input.icon_url, updatedAt: new Date() }).where(eq(servers.id, ctx.serverId));

      // Broadcast full server object so clients get consistent payloads
      const [updated] = await ctx.db.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);
      const formatted = formatServer(updated!);
      eventDispatcher.dispatchToServer(ctx.serverId, 'server.update', formatted);
      return { icon_url: input.icon_url };
    }),
});

import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { messages, attachments, reactions, channels, members, roles, memberRoles, readStates, serverConfig } from '../../db/schema/index.js';
import { eq, and, lt, gt, desc, asc, inArray, sql } from 'drizzle-orm';
import { generateUUIDv7, Permissions, parseMentions, MessageType, computePermissions, hasPermission } from 'ecto-shared';
import { formatMessage, formatAttachment, formatMessageAuthor } from '../../utils/format.js';
import { requirePermission, requireMember, buildPermissionContext } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { resolveUserProfiles } from '../../utils/resolve-profile.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';
import { sendNotification } from '../../ws/notify-ws.js';
import { groupReactions, hydrateMessages } from '../../utils/message-helpers.js';

export const messagesRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        before: z.string().uuid().optional(),
        after: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        pinned_only: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.READ_MESSAGES, input.channel_id);
      const d = ctx.db;
      const limit = input.limit ?? 50;

      const conditions = [eq(messages.channelId, input.channel_id), eq(messages.deleted, false)];
      if (input.before) conditions.push(lt(messages.id, input.before));
      if (input.after) conditions.push(gt(messages.id, input.after));
      if (input.pinned_only) conditions.push(eq(messages.pinned, true));

      const msgRows = await d
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.id))
        .limit(limit + 1);

      const has_more = msgRows.length > limit;
      const rows = has_more ? msgRows.slice(0, limit) : msgRows;

      if (rows.length === 0) return { messages: [], has_more: false };

      const formatted = await hydrateMessages(d, ctx.serverId, ctx.user.id, rows);
      return { messages: formatted.reverse(), has_more };
    }),

  send: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        content: z.string().min(1).max(4000).optional(),
        reply_to: z.string().uuid().optional(),
        attachment_ids: z.array(z.string().uuid()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.content && (!input.attachment_ids || input.attachment_ids.length === 0)) {
        throw ectoError('BAD_REQUEST', 3001, 'Message must have content or attachments');
      }

      // Block messages to page channels + fetch slowmode
      const [ch] = await ctx.db
        .select({ type: channels.type, slowmodeSeconds: channels.slowmodeSeconds })
        .from(channels)
        .where(eq(channels.id, input.channel_id))
        .limit(1);
      if (ch?.type === 'page') {
        throw ectoError('BAD_REQUEST', 3002, 'Cannot send messages to a page channel');
      }

      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.SEND_MESSAGES, input.channel_id);

      // Slowmode enforcement
      if (ch && ch.slowmodeSeconds > 0) {
        const permCtx = await buildPermissionContext(ctx.db, ctx.serverId, ctx.user.id, input.channel_id);
        const effective = computePermissions(permCtx);
        const canBypass = hasPermission(effective, Permissions.MANAGE_MESSAGES) || hasPermission(effective, Permissions.MANAGE_CHANNELS);
        if (!canBypass) {
          const [lastMsg] = await ctx.db
            .select({ createdAt: messages.createdAt })
            .from(messages)
            .where(and(eq(messages.channelId, input.channel_id), eq(messages.authorId, ctx.user.id), eq(messages.deleted, false)))
            .orderBy(desc(messages.createdAt))
            .limit(1);
          if (lastMsg) {
            const elapsed = (Date.now() - lastMsg.createdAt.getTime()) / 1000;
            if (elapsed < ch.slowmodeSeconds) {
              const retryAfter = Math.ceil(ch.slowmodeSeconds - elapsed);
              throw ectoError('TOO_MANY_REQUESTS', 3004, `Slowmode active. Try again in ${retryAfter}s`);
            }
          }
        }
      }
      if (input.attachment_ids?.length) {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.ATTACH_FILES, input.channel_id);
      }
      const d = ctx.db;

      // Parse mentions
      const parsed = input.content ? parseMentions(input.content) : { users: [], roles: [], channels: [], mentionEveryone: false };

      // Only mark @everyone / role mentions as effective if user has MENTION_EVERYONE permission.
      // Without permission, the raw text stays in content but flags are false — client renders as plain text.
      let canMentionEveryone = false;
      if (parsed.mentionEveryone || parsed.roles.length > 0) {
        const permCtx = await buildPermissionContext(d, ctx.serverId, ctx.user.id, input.channel_id);
        const effective = computePermissions(permCtx);
        canMentionEveryone = hasPermission(effective, Permissions.MENTION_EVERYONE);
      }

      const id = generateUUIDv7();
      await d.insert(messages).values({
        id,
        channelId: input.channel_id,
        authorId: ctx.user.id,
        content: input.content ?? null,
        type: MessageType.DEFAULT,
        replyTo: input.reply_to ?? null,
        mentionEveryone: canMentionEveryone && parsed.mentionEveryone,
        mentionRoles: canMentionEveryone && parsed.roles.length > 0 ? parsed.roles : null,
        mentionUsers: parsed.users.length > 0 ? parsed.users : null,
      });

      // Link attachment IDs
      if (input.attachment_ids?.length) {
        for (const attId of input.attachment_ids) {
          await d.update(attachments).set({ messageId: id }).where(eq(attachments.id, attId));
        }
      }

      // Collect user IDs that have already been notified (to avoid duplicates)
      const notifiedUsers = new Set<string>();

      // Update mention counts for mentioned users
      if (parsed.users.length > 0) {
        for (const mentionedUserId of parsed.users) {
          await d
            .insert(readStates)
            .values({
              userId: mentionedUserId,
              channelId: input.channel_id,
              mentionCount: 1,
            })
            .onConflictDoUpdate({
              target: [readStates.userId, readStates.channelId],
              set: { mentionCount: sql`${readStates.mentionCount} + 1` },
            });
          notifiedUsers.add(mentionedUserId);
          // Send real-time notification (skip self-mentions)
          if (mentionedUserId !== ctx.user.id) {
            eventDispatcher.dispatchToUser(mentionedUserId, 'mention.create', {
              channel_id: input.channel_id,
              message_id: id,
              author_id: ctx.user.id,
              content: input.content ?? '',
            });
            sendNotification(mentionedUserId, input.channel_id, 'mention');
          }
        }
      }

      // @everyone mention notifications (permission already checked above)
      if (canMentionEveryone && parsed.mentionEveryone) {
        const allMembers = await d
          .select({ userId: members.userId })
          .from(members)
          .where(eq(members.serverId, ctx.serverId));

        for (const m of allMembers) {
          if (m.userId === ctx.user.id || notifiedUsers.has(m.userId)) continue;
          notifiedUsers.add(m.userId);
          await d
            .insert(readStates)
            .values({ userId: m.userId, channelId: input.channel_id, mentionCount: 1 })
            .onConflictDoUpdate({
              target: [readStates.userId, readStates.channelId],
              set: { mentionCount: sql`${readStates.mentionCount} + 1` },
            });
          eventDispatcher.dispatchToUser(m.userId, 'mention.create', {
            channel_id: input.channel_id,
            message_id: id,
            author_id: ctx.user.id,
            content: input.content ?? '',
          });
          sendNotification(m.userId, input.channel_id, 'mention');
        }
      }

      // Role mention notifications (permission already checked above)
      if (canMentionEveryone && parsed.roles.length > 0) {
        // Get members who have any of the mentioned roles
        const roleMemberRows = await d
          .select({ memberId: memberRoles.memberId, roleId: memberRoles.roleId })
          .from(memberRoles)
          .where(inArray(memberRoles.roleId, parsed.roles));

        if (roleMemberRows.length > 0) {
          const memberIds = [...new Set(roleMemberRows.map((r) => r.memberId))];
          const memberRows = await d
            .select({ id: members.id, userId: members.userId })
            .from(members)
            .where(inArray(members.id, memberIds));

          for (const m of memberRows) {
            if (m.userId === ctx.user.id || notifiedUsers.has(m.userId)) continue;
            notifiedUsers.add(m.userId);
            await d
              .insert(readStates)
              .values({ userId: m.userId, channelId: input.channel_id, mentionCount: 1 })
              .onConflictDoUpdate({
                target: [readStates.userId, readStates.channelId],
                set: { mentionCount: sql`${readStates.mentionCount} + 1` },
              });
            eventDispatcher.dispatchToUser(m.userId, 'mention.create', {
              channel_id: input.channel_id,
              message_id: id,
              author_id: ctx.user.id,
              content: input.content ?? '',
            });
            sendNotification(m.userId, input.channel_id, 'mention');
          }
        }
      }

      // Fetch and return the created message
      const [row] = await d.select().from(messages).where(eq(messages.id, id)).limit(1);
      const profile = (await resolveUserProfiles(d, [ctx.user.id])).get(ctx.user.id) ?? { username: 'Unknown', display_name: null, avatar_url: null };
      const [member] = await d
        .select({ nickname: members.nickname })
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, ctx.user.id)))
        .limit(1);
      const author = formatMessageAuthor(profile, ctx.user.id, member?.nickname ?? null);
      const msgAttachments = input.attachment_ids?.length
        ? (await d.select().from(attachments).where(inArray(attachments.id, input.attachment_ids))).map(formatAttachment)
        : [];

      const formatted = formatMessage(row!, author, msgAttachments, []);
      eventDispatcher.dispatchToChannel(input.channel_id, 'message.create', formatted);
      return formatted;
    }),

  update: protectedProcedure
    .input(z.object({ message_id: z.string().uuid(), content: z.string().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [msg] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      if (!msg || msg.deleted) throw ectoError('NOT_FOUND', 4000, 'Message not found');
      if (msg.authorId !== ctx.user.id) throw ectoError('FORBIDDEN', 5001, 'Can only edit your own messages');

      await d.update(messages).set({ content: input.content, editedAt: new Date() }).where(eq(messages.id, input.message_id));

      const [updated] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      const profile = (await resolveUserProfiles(d, [ctx.user.id])).get(ctx.user.id) ?? { username: 'Unknown', display_name: null, avatar_url: null };
      const [member] = await d
        .select({ nickname: members.nickname })
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, ctx.user.id)))
        .limit(1);
      const author = formatMessageAuthor(profile, ctx.user.id, member?.nickname ?? null);
      const msgAttachments = (await d.select().from(attachments).where(eq(attachments.messageId, input.message_id))).map(formatAttachment);
      const reactionRows = await d.select().from(reactions).where(eq(reactions.messageId, input.message_id));
      const reactionGroups = groupReactions(reactionRows.map((r) => ({ emoji: r.emoji, userId: r.userId })), ctx.user.id);

      const formatted = formatMessage(updated!, author, msgAttachments, reactionGroups);
      eventDispatcher.dispatchToChannel(msg.channelId, 'message.update', formatted);
      return formatted;
    }),

  delete: protectedProcedure
    .input(z.object({ message_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [msg] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      if (!msg || msg.deleted) throw ectoError('NOT_FOUND', 4000, 'Message not found');

      if (msg.authorId !== ctx.user.id) {
        await requirePermission(d, ctx.serverId, ctx.user.id, Permissions.MANAGE_MESSAGES, msg.channelId);
        await insertAuditLog(d, {
          serverId: ctx.serverId,
          actorId: ctx.user.id,
          action: 'message.delete',
          targetType: 'message',
          targetId: input.message_id,
        });
      }

      await d.update(messages).set({ deleted: true }).where(eq(messages.id, input.message_id));
      eventDispatcher.dispatchToChannel(msg.channelId, 'message.delete', { id: input.message_id, channel_id: msg.channelId });
      return { success: true };
    }),

  pin: protectedProcedure
    .input(z.object({ message_id: z.string().uuid(), pinned: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [msg] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      if (!msg || msg.deleted) throw ectoError('NOT_FOUND', 4000, 'Message not found');

      await requirePermission(d, ctx.serverId, ctx.user.id, Permissions.MANAGE_MESSAGES, msg.channelId);

      await d.update(messages).set({ pinned: input.pinned }).where(eq(messages.id, input.message_id));

      // Insert and broadcast system message for pin (if enabled)
      if (input.pinned) {
        const [srvCfg] = await d
          .select()
          .from(serverConfig)
          .where(eq(serverConfig.serverId, ctx.serverId))
          .limit(1);

        if (srvCfg?.showSystemMessages !== false) {
          const sysId = generateUUIDv7();
          await d.insert(messages).values({
            id: sysId,
            channelId: msg.channelId,
            authorId: ctx.user.id,
            content: null,
            type: MessageType.PIN_ADDED,
            replyTo: input.message_id,
          });
          const [sysRow] = await d.select().from(messages).where(eq(messages.id, sysId)).limit(1);
          if (sysRow) {
            const pinnerProfile = (await resolveUserProfiles(d, [ctx.user.id])).get(ctx.user.id) ?? { username: 'Unknown', display_name: null, avatar_url: null };
            const [pinnerMember] = await d
              .select({ nickname: members.nickname })
              .from(members)
              .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, ctx.user.id)))
              .limit(1);
            const pinnerAuthor = formatMessageAuthor(pinnerProfile, ctx.user.id, pinnerMember?.nickname ?? null);
            const sysFormatted = formatMessage(sysRow, pinnerAuthor, [], []);
            eventDispatcher.dispatchToChannel(msg.channelId, 'message.create', sysFormatted);
          }
        }
      }

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'message.pin',
        targetType: 'message',
        targetId: input.message_id,
        details: { pinned: input.pinned },
      });

      // Return updated message
      const [updated] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      const profile = (await resolveUserProfiles(d, [msg.authorId])).get(msg.authorId) ?? { username: 'Unknown', display_name: null, avatar_url: null };
      const [member] = await d
        .select({ nickname: members.nickname })
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, msg.authorId)))
        .limit(1);
      const author = formatMessageAuthor(profile, msg.authorId, member?.nickname ?? null);
      const msgAttachments = (await d.select().from(attachments).where(eq(attachments.messageId, input.message_id))).map(formatAttachment);
      const reactionRows = await d.select().from(reactions).where(eq(reactions.messageId, input.message_id));
      const reactionGroups = groupReactions(reactionRows.map((r) => ({ emoji: r.emoji, userId: r.userId })), ctx.user.id);

      const pinnedFormatted = formatMessage(updated!, author, msgAttachments, reactionGroups);
      eventDispatcher.dispatchToChannel(msg.channelId, 'message.update', pinnedFormatted);
      return pinnedFormatted;
    }),

  react: protectedProcedure
    .input(
      z.object({
        message_id: z.string().uuid(),
        emoji: z.string().min(1).max(64),
        action: z.enum(['add', 'remove']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const d = ctx.db;
      const [msg] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      if (!msg || msg.deleted) throw ectoError('NOT_FOUND', 4000, 'Message not found');

      if (input.action === 'add') {
        await requirePermission(d, ctx.serverId, ctx.user.id, Permissions.ADD_REACTIONS, msg.channelId);
        await d
          .insert(reactions)
          .values({
            id: generateUUIDv7(),
            messageId: input.message_id,
            userId: ctx.user.id,
            emoji: input.emoji,
          })
          .onConflictDoNothing();
      } else {
        await d
          .delete(reactions)
          .where(
            and(
              eq(reactions.messageId, input.message_id),
              eq(reactions.userId, ctx.user.id),
              eq(reactions.emoji, input.emoji),
            ),
          );
      }

      // Return updated reaction groups
      const reactionRows = await d.select().from(reactions).where(eq(reactions.messageId, input.message_id));
      const groups = groupReactions(reactionRows.map((r) => ({ emoji: r.emoji, userId: r.userId })), ctx.user.id);
      const reactionCount = groups.find((g) => g.emoji === input.emoji)?.count ?? 0;
      eventDispatcher.dispatchToChannel(msg.channelId, 'message.reaction_update', {
        channel_id: msg.channelId,
        message_id: input.message_id,
        emoji: input.emoji,
        user_id: ctx.user.id,
        action: input.action,
        count: reactionCount,
      });
      return groups;
    }),
});

import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { messages, attachments, reactions, channels, members, readStates, serverConfig } from '../../db/schema/index.js';
import { eq, and, lt, gt, desc, asc, inArray, sql } from 'drizzle-orm';
import { generateUUIDv7, Permissions, parseMentions, MessageType } from 'ecto-shared';
import { formatMessage, formatAttachment, formatMessageAuthor } from '../../utils/format.js';
import { requirePermission, requireMember } from '../../utils/permission-context.js';
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
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.SEND_MESSAGES, input.channel_id);
      if (input.attachment_ids?.length) {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.ATTACH_FILES, input.channel_id);
      }
      const d = ctx.db;

      // Parse mentions
      const parsed = input.content ? parseMentions(input.content) : { users: [], roles: [], channels: [], mentionEveryone: false };

      const id = generateUUIDv7();
      await d.insert(messages).values({
        id,
        channelId: input.channel_id,
        authorId: ctx.user.id,
        content: input.content ?? null,
        type: MessageType.DEFAULT,
        replyTo: input.reply_to ?? null,
        mentionEveryone: parsed.mentionEveryone,
        mentionRoles: parsed.roles.length > 0 ? parsed.roles : null,
        mentionUsers: parsed.users.length > 0 ? parsed.users : null,
      });

      // Link attachment IDs
      if (input.attachment_ids?.length) {
        for (const attId of input.attachment_ids) {
          await d.update(attachments).set({ messageId: id }).where(eq(attachments.id, attId));
        }
      }

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
          // Send real-time notification (skip self-mentions)
          if (mentionedUserId !== ctx.user.id) {
            // Main WS: user-targeted mention event (works even if user is on a different channel)
            eventDispatcher.dispatchToUser(mentionedUserId, 'mention.create', {
              channel_id: input.channel_id,
              message_id: id,
              author_id: ctx.user.id,
              content: input.content ?? '',
            });
            // Notify WS: for background servers
            sendNotification(mentionedUserId, input.channel_id, 'mention');
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

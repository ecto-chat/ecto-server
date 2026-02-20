import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import {
  dmConversations,
  dmReadStates,
  messages,
  attachments,
  reactions,
  members,
  serverConfig,
} from '../../db/schema/index.js';
import { eq, and, or, ne, lt, gt, desc, inArray, sql, count as countFn } from 'drizzle-orm';
import { generateUUIDv7, MessageType } from 'ecto-shared';
import type { ServerDmConversation, ServerDmMessage } from 'ecto-shared';
import {
  formatMessageAuthor,
  formatAttachment,
} from '../../utils/format.js';
import { requireMember } from '../../utils/permission-context.js';
import { ectoError } from '../../utils/errors.js';
import { resolveUserProfiles } from '../../utils/resolve-profile.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';
import { groupReactions, hydrateMessages } from '../../utils/message-helpers.js';

/** Ensure canonical ordering for DM conversation participants */
function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function requireDmEnabled(d: Parameters<typeof requireMember>[0], serverId: string) {
  const [cfg] = await d
    .select({ allowMemberDms: serverConfig.allowMemberDms })
    .from(serverConfig)
    .where(eq(serverConfig.serverId, serverId))
    .limit(1);
  if (!cfg?.allowMemberDms) {
    throw ectoError('FORBIDDEN', 6001, 'Server DMs are not enabled on this server');
  }
}

function formatServerDmMessage(
  row: {
    id: string;
    channelId: string;
    authorId: string;
    content: string | null;
    editedAt: Date | null;
    createdAt: Date;
  },
  author: ReturnType<typeof formatMessageAuthor>,
  msgAttachments: ReturnType<typeof formatAttachment>[],
  reactionGroups: ReturnType<typeof groupReactions>,
): ServerDmMessage {
  return {
    id: row.id,
    conversation_id: row.channelId,
    author,
    content: row.content,
    attachments: msgAttachments,
    reactions: reactionGroups,
    edited_at: row.editedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export const serverDmsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);
    await requireDmEnabled(ctx.db, ctx.serverId);
    const d = ctx.db;

    // Find all conversations where this user is a participant
    const convos = await d
      .select()
      .from(dmConversations)
      .where(
        and(
          eq(dmConversations.serverId, ctx.serverId),
          or(
            eq(dmConversations.userA, ctx.user.id),
            eq(dmConversations.userB, ctx.user.id),
          ),
        ),
      )
      .orderBy(desc(dmConversations.lastMessageAt));

    if (convos.length === 0) return [];

    // Collect peer IDs
    const peerIds = convos.map((c) =>
      c.userA === ctx.user.id ? c.userB : c.userA,
    );
    const profiles = await resolveUserProfiles(d, peerIds);

    // Get peer nicknames
    const peerMembers = peerIds.length > 0
      ? await d
          .select({ userId: members.userId, nickname: members.nickname })
          .from(members)
          .where(and(eq(members.serverId, ctx.serverId), inArray(members.userId, peerIds)))
      : [];
    const nicknameMap = new Map(peerMembers.map((m) => [m.userId, m.nickname]));

    // Get last message for each conversation
    const convoIds = convos.map((c) => c.id);
    const lastMessages = convoIds.length > 0
      ? await d
          .select()
          .from(messages)
          .where(and(inArray(messages.channelId, convoIds), eq(messages.deleted, false)))
          .orderBy(desc(messages.id))
      : [];

    // Group by convo and pick the latest
    const lastMsgByConvo = new Map<string, typeof lastMessages[0]>();
    for (const msg of lastMessages) {
      if (!lastMsgByConvo.has(msg.channelId)) {
        lastMsgByConvo.set(msg.channelId, msg);
      }
    }

    // Hydrate last message authors
    const lastMsgRows = [...lastMsgByConvo.values()];
    const lastMsgAuthorIds = [...new Set(lastMsgRows.map((m) => m.authorId))];
    const lastMsgProfiles = lastMsgAuthorIds.length > 0
      ? await resolveUserProfiles(d, lastMsgAuthorIds)
      : new Map<string, { username: string; display_name: string | null; avatar_url: string | null }>();
    const lastMsgMemberRows = lastMsgAuthorIds.length > 0
      ? await d
          .select({ userId: members.userId, nickname: members.nickname })
          .from(members)
          .where(and(eq(members.serverId, ctx.serverId), inArray(members.userId, lastMsgAuthorIds)))
      : [];
    const lastMsgNicknames = new Map(lastMsgMemberRows.map((m) => [m.userId, m.nickname]));

    // Fetch read states to compute unread counts
    const readStateRows = convoIds.length > 0
      ? await d
          .select()
          .from(dmReadStates)
          .where(and(eq(dmReadStates.userId, ctx.user.id), inArray(dmReadStates.conversationId, convoIds)))
      : [];
    const readStateMap = new Map(readStateRows.map((r) => [r.conversationId, r.lastReadMessageId]));

    // Count unread messages per conversation (messages after lastReadMessageId)
    const unreadCountMap = new Map<string, number>();
    for (const convoId of convoIds) {
      const lastReadId = readStateMap.get(convoId);
      const conditions = [
        eq(messages.channelId, convoId),
        eq(messages.deleted, false),
        ne(messages.authorId, ctx.user.id),
      ];
      if (lastReadId) {
        conditions.push(gt(messages.id, lastReadId));
      }
      const [result] = await d
        .select({ value: countFn() })
        .from(messages)
        .where(and(...conditions));
      unreadCountMap.set(convoId, Number(result?.value ?? 0));
    }

    const resultList: ServerDmConversation[] = convos.map((c) => {
      const peerId = c.userA === ctx.user.id ? c.userB : c.userA;
      const profile = profiles.get(peerId) ?? { username: 'Unknown', display_name: null, avatar_url: null };

      const lastMsgRow = lastMsgByConvo.get(c.id);
      let lastMessage: ServerDmMessage | null = null;
      if (lastMsgRow) {
        const msgProfile = lastMsgProfiles.get(lastMsgRow.authorId) ?? { username: 'Unknown', display_name: null, avatar_url: null };
        const author = formatMessageAuthor(msgProfile, lastMsgRow.authorId, lastMsgNicknames.get(lastMsgRow.authorId) ?? null);
        lastMessage = formatServerDmMessage(lastMsgRow, author, [], []);
      }

      return {
        id: c.id,
        peer: {
          user_id: peerId,
          username: profile.username,
          display_name: profile.display_name,
          avatar_url: profile.avatar_url,
          nickname: nicknameMap.get(peerId) ?? null,
        },
        last_message: lastMessage,
        unread_count: unreadCountMap.get(c.id) ?? 0,
      };
    });

    return resultList;
  }),

  history: protectedProcedure
    .input(
      z.object({
        conversation_id: z.string().uuid(),
        before: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      await requireDmEnabled(ctx.db, ctx.serverId);
      const d = ctx.db;

      // Verify caller is a participant
      const [convo] = await d
        .select()
        .from(dmConversations)
        .where(
          and(
            eq(dmConversations.id, input.conversation_id),
            eq(dmConversations.serverId, ctx.serverId),
            or(
              eq(dmConversations.userA, ctx.user.id),
              eq(dmConversations.userB, ctx.user.id),
            ),
          ),
        )
        .limit(1);
      if (!convo) throw ectoError('NOT_FOUND', 6002, 'Conversation not found');

      const limit = input.limit ?? 50;
      const conditions = [
        eq(messages.channelId, input.conversation_id),
        eq(messages.deleted, false),
      ];
      if (input.before) conditions.push(lt(messages.id, input.before));

      const msgRows = await d
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.id))
        .limit(limit + 1);

      const has_more = msgRows.length > limit;
      const rows = has_more ? msgRows.slice(0, limit) : msgRows;

      if (rows.length === 0) return { messages: [] as ServerDmMessage[], has_more: false };

      // Hydrate using the shared helper, then convert to ServerDmMessage
      const hydrated = await hydrateMessages(d, ctx.serverId, ctx.user.id, rows);
      const serverDmMessages: ServerDmMessage[] = hydrated.map((m) => ({
        id: m.id,
        conversation_id: m.channel_id,
        author: m.author,
        content: m.content,
        attachments: m.attachments,
        reactions: m.reactions,
        edited_at: m.edited_at,
        created_at: m.created_at,
      }));

      return { messages: serverDmMessages.reverse(), has_more };
    }),

  send: protectedProcedure
    .input(
      z.object({
        recipient_id: z.string().uuid(),
        content: z.string().min(1).max(4000),
        attachment_ids: z.array(z.string().uuid()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.recipient_id === ctx.user.id) {
        throw ectoError('BAD_REQUEST', 6003, 'Cannot send a DM to yourself');
      }

      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      await requireDmEnabled(ctx.db, ctx.serverId);
      const d = ctx.db;

      // Verify recipient is a member and allows DMs
      const [recipientMember] = await d
        .select()
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, input.recipient_id)))
        .limit(1);
      if (!recipientMember) {
        throw ectoError('NOT_FOUND', 6004, 'Recipient is not a member of this server');
      }
      if (!recipientMember.allowDms) {
        throw ectoError('FORBIDDEN', 6005, 'Recipient has disabled private messages');
      }

      // Get or create conversation (canonical ordering)
      const [userA, userB] = canonicalPair(ctx.user.id, input.recipient_id);
      let [convo] = await d
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

      if (!convo) {
        const convoId = generateUUIDv7();
        await d.insert(dmConversations).values({
          id: convoId,
          serverId: ctx.serverId,
          userA,
          userB,
        });
        [convo] = await d
          .select()
          .from(dmConversations)
          .where(eq(dmConversations.id, convoId))
          .limit(1);
      }

      // Insert message
      const msgId = generateUUIDv7();
      await d.insert(messages).values({
        id: msgId,
        channelId: convo!.id,
        authorId: ctx.user.id,
        content: input.content,
        type: MessageType.DEFAULT,
      });

      // Link attachments
      if (input.attachment_ids?.length) {
        for (const attId of input.attachment_ids) {
          await d.update(attachments).set({ messageId: msgId }).where(eq(attachments.id, attId));
        }
      }

      // Update lastMessageAt
      await d
        .update(dmConversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(dmConversations.id, convo!.id));

      // Fetch and format the message
      const [row] = await d.select().from(messages).where(eq(messages.id, msgId)).limit(1);
      const profile = (await resolveUserProfiles(d, [ctx.user.id])).get(ctx.user.id) ?? {
        username: 'Unknown',
        display_name: null,
        avatar_url: null,
      };
      const [senderMember] = await d
        .select({ nickname: members.nickname })
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, ctx.user.id)))
        .limit(1);
      const author = formatMessageAuthor(profile, ctx.user.id, senderMember?.nickname ?? null);
      const msgAttachments = input.attachment_ids?.length
        ? (await d.select().from(attachments).where(inArray(attachments.id, input.attachment_ids))).map(formatAttachment)
        : [];

      const formatted = formatServerDmMessage(row!, author, msgAttachments, []);

      // Dispatch to both participants
      eventDispatcher.dispatchToUser(ctx.user.id, 'server_dm.message', {
        ...formatted,
        _conversation_peer_id: input.recipient_id,
      });
      eventDispatcher.dispatchToUser(input.recipient_id, 'server_dm.message', {
        ...formatted,
        _conversation_peer_id: ctx.user.id,
      });

      return formatted;
    }),

  edit: protectedProcedure
    .input(z.object({ message_id: z.string().uuid(), content: z.string().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      const d = ctx.db;

      const [msg] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      if (!msg || msg.deleted) throw ectoError('NOT_FOUND', 4000, 'Message not found');
      if (msg.authorId !== ctx.user.id) throw ectoError('FORBIDDEN', 5001, 'Can only edit your own messages');

      // Verify message belongs to a DM conversation on this server
      const [convo] = await d
        .select()
        .from(dmConversations)
        .where(and(eq(dmConversations.id, msg.channelId), eq(dmConversations.serverId, ctx.serverId)))
        .limit(1);
      if (!convo) throw ectoError('NOT_FOUND', 6002, 'Conversation not found');

      await d.update(messages).set({ content: input.content, editedAt: new Date() }).where(eq(messages.id, input.message_id));

      const [updated] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      const profile = (await resolveUserProfiles(d, [ctx.user.id])).get(ctx.user.id) ?? {
        username: 'Unknown',
        display_name: null,
        avatar_url: null,
      };
      const [member] = await d
        .select({ nickname: members.nickname })
        .from(members)
        .where(and(eq(members.serverId, ctx.serverId), eq(members.userId, ctx.user.id)))
        .limit(1);
      const author = formatMessageAuthor(profile, ctx.user.id, member?.nickname ?? null);
      const msgAttachments = (await d.select().from(attachments).where(eq(attachments.messageId, input.message_id))).map(formatAttachment);
      const reactionRows = await d.select().from(reactions).where(eq(reactions.messageId, input.message_id));
      const reactionGroups = groupReactions(reactionRows.map((r) => ({ emoji: r.emoji, userId: r.userId })), ctx.user.id);

      const formatted = formatServerDmMessage(updated!, author, msgAttachments, reactionGroups);

      // Dispatch to both participants
      const peerId = convo.userA === ctx.user.id ? convo.userB : convo.userA;
      eventDispatcher.dispatchToUser(ctx.user.id, 'server_dm.update', formatted);
      eventDispatcher.dispatchToUser(peerId, 'server_dm.update', formatted);

      return formatted;
    }),

  delete: protectedProcedure
    .input(z.object({ message_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      const d = ctx.db;

      const [msg] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      if (!msg || msg.deleted) throw ectoError('NOT_FOUND', 4000, 'Message not found');
      if (msg.authorId !== ctx.user.id) throw ectoError('FORBIDDEN', 5001, 'Can only delete your own messages');

      const [convo] = await d
        .select()
        .from(dmConversations)
        .where(and(eq(dmConversations.id, msg.channelId), eq(dmConversations.serverId, ctx.serverId)))
        .limit(1);
      if (!convo) throw ectoError('NOT_FOUND', 6002, 'Conversation not found');

      await d.update(messages).set({ deleted: true }).where(eq(messages.id, input.message_id));

      const payload = { id: input.message_id, conversation_id: msg.channelId };
      const peerId = convo.userA === ctx.user.id ? convo.userB : convo.userA;
      eventDispatcher.dispatchToUser(ctx.user.id, 'server_dm.delete', payload);
      eventDispatcher.dispatchToUser(peerId, 'server_dm.delete', payload);

      return { success: true };
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
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      const d = ctx.db;

      const [msg] = await d.select().from(messages).where(eq(messages.id, input.message_id)).limit(1);
      if (!msg || msg.deleted) throw ectoError('NOT_FOUND', 4000, 'Message not found');

      // Verify participant
      const [convo] = await d
        .select()
        .from(dmConversations)
        .where(
          and(
            eq(dmConversations.id, msg.channelId),
            eq(dmConversations.serverId, ctx.serverId),
            or(
              eq(dmConversations.userA, ctx.user.id),
              eq(dmConversations.userB, ctx.user.id),
            ),
          ),
        )
        .limit(1);
      if (!convo) throw ectoError('NOT_FOUND', 6002, 'Conversation not found');

      if (input.action === 'add') {
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

      const reactionRows = await d.select().from(reactions).where(eq(reactions.messageId, input.message_id));
      const groups = groupReactions(reactionRows.map((r) => ({ emoji: r.emoji, userId: r.userId })), ctx.user.id);
      const reactionCount = groups.find((g) => g.emoji === input.emoji)?.count ?? 0;

      const payload = {
        conversation_id: msg.channelId,
        message_id: input.message_id,
        emoji: input.emoji,
        user_id: ctx.user.id,
        action: input.action,
        count: reactionCount,
      };
      const peerId = convo.userA === ctx.user.id ? convo.userB : convo.userA;
      eventDispatcher.dispatchToUser(ctx.user.id, 'server_dm.reaction_update', payload);
      eventDispatcher.dispatchToUser(peerId, 'server_dm.reaction_update', payload);

      return groups;
    }),

  markRead: protectedProcedure
    .input(z.object({ conversation_id: z.string().uuid(), last_read_message_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      const d = ctx.db;

      // Verify participant
      const [convo] = await d
        .select()
        .from(dmConversations)
        .where(
          and(
            eq(dmConversations.id, input.conversation_id),
            eq(dmConversations.serverId, ctx.serverId),
            or(
              eq(dmConversations.userA, ctx.user.id),
              eq(dmConversations.userB, ctx.user.id),
            ),
          ),
        )
        .limit(1);
      if (!convo) throw ectoError('NOT_FOUND', 6002, 'Conversation not found');

      await d
        .insert(dmReadStates)
        .values({
          userId: ctx.user.id,
          conversationId: input.conversation_id,
          lastReadMessageId: input.last_read_message_id,
        })
        .onConflictDoUpdate({
          target: [dmReadStates.userId, dmReadStates.conversationId],
          set: {
            lastReadMessageId: input.last_read_message_id,
            updatedAt: new Date(),
          },
        });

      return { success: true };
    }),
});

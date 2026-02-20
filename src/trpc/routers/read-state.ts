import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { readStates, channels, messages } from '../../db/schema/index.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { requireMember } from '../../utils/permission-context.js';
import { formatReadState } from '../../utils/format.js';

export const readStateRouter = router({
  update: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        last_read_message_id: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);

      await ctx.db
        .insert(readStates)
        .values({
          userId: ctx.user.id,
          channelId: input.channel_id,
          lastReadMessageId: input.last_read_message_id,
          mentionCount: 0,
        })
        .onConflictDoUpdate({
          target: [readStates.userId, readStates.channelId],
          set: {
            lastReadMessageId: input.last_read_message_id,
            mentionCount: 0,
            updatedAt: new Date(),
          },
        });

      return { success: true };
    }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);

    // Get latest message per channel for this server
    const serverChannels = await ctx.db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.serverId, ctx.serverId));

    if (serverChannels.length === 0) return { success: true };

    const channelIds = serverChannels.map((c) => c.id);
    const d = ctx.db;

    // Single query: get latest non-deleted message per channel
    const latestMessages = await d
      .select({
        channelId: messages.channelId,
        messageId: sql<string>`(
          SELECT m2.id FROM messages m2
          WHERE m2.channel_id = ${messages.channelId}
            AND m2.deleted = false
          ORDER BY m2.created_at DESC
          LIMIT 1
        )`.as('latest_id'),
      })
      .from(messages)
      .where(and(inArray(messages.channelId, channelIds), eq(messages.deleted, false)))
      .groupBy(messages.channelId);

    // Batch upsert read states
    for (const row of latestMessages) {
      if (!row.messageId) continue;
      await d
        .insert(readStates)
        .values({
          userId: ctx.user.id,
          channelId: row.channelId,
          lastReadMessageId: row.messageId,
          mentionCount: 0,
        })
        .onConflictDoUpdate({
          target: [readStates.userId, readStates.channelId],
          set: {
            lastReadMessageId: row.messageId,
            mentionCount: 0,
            updatedAt: new Date(),
          },
        });
    }

    return { success: true };
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);

    // Scope to channels belonging to this server
    const rows = await ctx.db
      .select({
        userId: readStates.userId,
        channelId: readStates.channelId,
        lastReadMessageId: readStates.lastReadMessageId,
        mentionCount: readStates.mentionCount,
      })
      .from(readStates)
      .innerJoin(channels, eq(readStates.channelId, channels.id))
      .where(and(eq(readStates.userId, ctx.user.id), eq(channels.serverId, ctx.serverId)));

    return rows.map(formatReadState);
  }),
});

import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { readStates, channels, messages } from '../../db/schema/index.js';
import { eq, and, desc } from 'drizzle-orm';
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

    // For each channel, find the latest message and upsert read state
    for (const channelId of channelIds) {
      const [latest] = await ctx.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.channelId, channelId), eq(messages.deleted, false)))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      if (latest) {
        await ctx.db
          .insert(readStates)
          .values({
            userId: ctx.user.id,
            channelId,
            lastReadMessageId: latest.id,
            mentionCount: 0,
          })
          .onConflictDoUpdate({
            target: [readStates.userId, readStates.channelId],
            set: {
              lastReadMessageId: latest.id,
              mentionCount: 0,
              updatedAt: new Date(),
            },
          });
      }
    }

    return { success: true };
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);

    const rows = await ctx.db
      .select()
      .from(readStates)
      .where(eq(readStates.userId, ctx.user.id));

    return rows.map(formatReadState);
  }),
});

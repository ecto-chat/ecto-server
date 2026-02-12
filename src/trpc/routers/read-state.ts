import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { readStates } from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
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

  list: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);

    const rows = await ctx.db
      .select()
      .from(readStates)
      .where(eq(readStates.userId, ctx.user.id));

    return rows.map(formatReadState);
  }),
});

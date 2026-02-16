import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { messages } from '../../db/schema/index.js';
import { eq, and, lt, gt, desc, sql, like } from 'drizzle-orm';
import { Permissions } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { config } from '../../config/index.js';
import { hydrateMessages } from '../../utils/message-helpers.js';

export const searchRouter = router({
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(200),
        channel_id: z.string().uuid().optional(),
        author_id: z.string().uuid().optional(),
        before: z.string().uuid().optional(),
        after: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const d = ctx.db;
      const limit = input.limit ?? 25;

      // If searching a specific channel, verify permission
      if (input.channel_id) {
        await requirePermission(d, ctx.serverId, ctx.user.id, Permissions.READ_MESSAGES, input.channel_id);
      }

      const isPg = config.DATABASE_TYPE === 'pg';

      // Build conditions
      const conditions = [eq(messages.deleted, false)];
      if (input.channel_id) conditions.push(eq(messages.channelId, input.channel_id));
      if (input.author_id) conditions.push(eq(messages.authorId, input.author_id));
      if (input.before) conditions.push(lt(messages.id, input.before));
      if (input.after) conditions.push(gt(messages.id, input.after));

      let rows: (typeof messages.$inferSelect)[];

      if (isPg) {
        // PostgreSQL: use tsvector full-text search
        conditions.push(
          sql`"messages"."search_vector" @@ plainto_tsquery('english', ${input.query})`,
        );
        rows = await d
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(
            sql`ts_rank("messages"."search_vector", plainto_tsquery('english', ${input.query})) DESC`,
            desc(messages.id),
          )
          .limit(limit + 1);
      } else {
        // SQLite: LIKE fallback
        conditions.push(like(messages.content, `%${input.query}%`));
        rows = await d
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(desc(messages.id))
          .limit(limit + 1);
      }

      const hasMore = rows.length > limit;
      const resultRows = hasMore ? rows.slice(0, limit) : rows;

      if (resultRows.length === 0) return { messages: [], has_more: false };

      const formatted = await hydrateMessages(d, ctx.serverId, ctx.user.id, resultRows);
      return { messages: formatted, has_more: hasMore };
    }),
});

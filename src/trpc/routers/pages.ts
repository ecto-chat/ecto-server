import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { channels, pageContents, pageRevisions } from '../../db/schema/index.js';
import { eq, and, desc, lt } from 'drizzle-orm';
import { generateUUIDv7, Permissions } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { ectoError } from '../../utils/errors.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';

const MAX_PAGE_CONTENT_LENGTH = 100_000;

export const pagesRouter = router({
  getContent: protectedProcedure
    .input(z.object({ channel_id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.READ_MESSAGES, input.channel_id);

      let [row] = await ctx.db
        .select()
        .from(pageContents)
        .where(eq(pageContents.channelId, input.channel_id))
        .limit(1);

      // Auto-create missing page_contents row for page channels (backfill)
      if (!row) {
        const [ch] = await ctx.db
          .select({ type: channels.type })
          .from(channels)
          .where(and(eq(channels.id, input.channel_id), eq(channels.serverId, ctx.serverId)))
          .limit(1);

        if (!ch || ch.type !== 'page') {
          throw ectoError('NOT_FOUND', 3000, 'Page content not found');
        }

        const now = new Date();
        await ctx.db.insert(pageContents).values({
          channelId: input.channel_id,
          content: '',
          version: 1,
          editedBy: null,
          editedAt: now,
        });

        row = {
          channelId: input.channel_id,
          content: '',
          bannerUrl: null,
          version: 1,
          editedBy: null,
          editedAt: now,
        };
      }

      return {
        channel_id: row.channelId,
        content: row.content,
        banner_url: row.bannerUrl ?? null,
        version: row.version,
        edited_by: row.editedBy,
        edited_at: row.editedAt.toISOString(),
      };
    }),

  updateContent: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        content: z.string().max(MAX_PAGE_CONTENT_LENGTH),
        version: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Check channel type
      const [ch] = await ctx.db
        .select({ type: channels.type })
        .from(channels)
        .where(and(eq(channels.id, input.channel_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!ch) throw ectoError('NOT_FOUND', 3000, 'Channel not found');
      if (ch.type !== 'page') throw ectoError('BAD_REQUEST', 3002, 'Channel is not a page channel');

      // Check EDIT_PAGES permission (ADMINISTRATOR is handled by computePermissions)
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.EDIT_PAGES, input.channel_id);

      const d = ctx.db;
      const result = await d.transaction(async (tx) => {
        // Optimistic concurrency check
        const [current] = await tx
          .select()
          .from(pageContents)
          .where(eq(pageContents.channelId, input.channel_id))
          .limit(1);

        if (!current) throw ectoError('NOT_FOUND', 3000, 'Page content not found');
        if (current.version !== input.version) {
          throw ectoError('CONFLICT', 3003, 'Version conflict — page was edited by someone else');
        }

        // Snapshot current content as a revision
        await tx.insert(pageRevisions).values({
          id: generateUUIDv7(),
          channelId: input.channel_id,
          content: current.content,
          version: current.version,
          editedBy: ctx.user.id,
          createdAt: new Date(),
        });

        const newVersion = current.version + 1;
        const editedAt = new Date();

        // Update page content
        await tx
          .update(pageContents)
          .set({
            content: input.content,
            version: newVersion,
            editedBy: ctx.user.id,
            editedAt,
          })
          .where(eq(pageContents.channelId, input.channel_id));

        return {
          channel_id: input.channel_id,
          content: input.content,
          banner_url: current.bannerUrl ?? null,
          version: newVersion,
          edited_by: ctx.user.id,
          edited_at: editedAt.toISOString(),
        };
      });

      // Broadcast to all clients subscribed to this channel
      eventDispatcher.dispatchToChannel(input.channel_id, 'page.update', result);

      return result;
    }),

  updateBanner: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        banner_url: z.string().max(512).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [ch] = await ctx.db
        .select({ type: channels.type })
        .from(channels)
        .where(and(eq(channels.id, input.channel_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!ch) throw ectoError('NOT_FOUND', 3000, 'Channel not found');
      if (ch.type !== 'page') throw ectoError('BAD_REQUEST', 3002, 'Channel is not a page channel');

      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.EDIT_PAGES, input.channel_id);

      await ctx.db
        .update(pageContents)
        .set({ bannerUrl: input.banner_url })
        .where(eq(pageContents.channelId, input.channel_id));

      // Fetch updated row to broadcast
      const [updated] = await ctx.db
        .select()
        .from(pageContents)
        .where(eq(pageContents.channelId, input.channel_id))
        .limit(1);

      if (updated) {
        const payload = {
          channel_id: updated.channelId,
          content: updated.content,
          banner_url: updated.bannerUrl ?? null,
          version: updated.version,
          edited_by: updated.editedBy,
          edited_at: updated.editedAt.toISOString(),
        };
        eventDispatcher.dispatchToChannel(input.channel_id, 'page.update', payload);
      }

      return { banner_url: input.banner_url };
    }),

  getHistory: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().uuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.READ_MESSAGES, input.channel_id);

      const limit = input.limit ?? 20;
      const conditions = [eq(pageRevisions.channelId, input.channel_id)];
      if (input.cursor) {
        conditions.push(lt(pageRevisions.id, input.cursor));
      }

      const rows = await ctx.db
        .select()
        .from(pageRevisions)
        .where(and(...conditions))
        .orderBy(desc(pageRevisions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      return {
        revisions: items.map((r) => ({
          id: r.id,
          channel_id: r.channelId,
          content: r.content,
          version: r.version,
          edited_by: r.editedBy,
          created_at: r.createdAt.toISOString(),
        })),
        has_more: hasMore,
      };
    }),
});

import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { activityItems, channels, members } from '../../db/schema/index.js';
import { eq, and, lt, desc, inArray, count as countFn } from 'drizzle-orm';
import { requireMember } from '../../utils/permission-context.js';
import { resolveUserProfiles } from '../../utils/resolve-profile.js';
import { formatMessageAuthor } from '../../utils/format.js';
import type { ActivityItem, ActivityListResponse } from 'ecto-shared';

export const activityRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        before: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        type: z.enum(['mention', 'reaction', 'server_dm']).optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<ActivityListResponse> => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      const d = ctx.db;
      const limit = input.limit ?? 30;

      const conditions = [eq(activityItems.userId, ctx.user.id)];
      if (input.before) conditions.push(lt(activityItems.id, input.before));
      if (input.type) conditions.push(eq(activityItems.type, input.type));

      const rows = await d
        .select()
        .from(activityItems)
        .where(and(...conditions))
        .orderBy(desc(activityItems.createdAt))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      if (items.length === 0) return { items: [], has_more: false };

      // Resolve actor profiles
      const actorIds = [...new Set(items.map((r) => r.actorId))];
      const profiles = await resolveUserProfiles(d, actorIds);

      // Resolve channel names
      const channelIds = [...new Set(items.filter((r) => r.channelId).map((r) => r.channelId!))];
      const channelRows = channelIds.length > 0
        ? await d.select({ id: channels.id, name: channels.name }).from(channels).where(inArray(channels.id, channelIds))
        : [];
      const channelMap = new Map(channelRows.map((c) => [c.id, c.name]));

      // Resolve actor nicknames
      const memberRows = actorIds.length > 0
        ? await d
            .select({ userId: members.userId, nickname: members.nickname })
            .from(members)
            .where(and(eq(members.serverId, ctx.serverId), inArray(members.userId, actorIds)))
        : [];
      const nicknameMap = new Map(memberRows.map((m) => [m.userId, m.nickname]));

      const formatted: ActivityItem[] = items.map((row) => {
        const profile = profiles.get(row.actorId) ?? { username: 'Unknown', display_name: null, avatar_url: null };
        const actor = formatMessageAuthor(profile, row.actorId, nicknameMap.get(row.actorId) ?? null);

        return {
          id: row.id,
          type: row.type as ActivityItem['type'],
          actor,
          content_preview: row.contentPreview ?? '',
          emoji: row.emoji ?? undefined,
          message_id: row.messageId ?? undefined,
          source: {
            server_id: ctx.serverId,
            channel_id: row.channelId ?? undefined,
            channel_name: row.channelId ? channelMap.get(row.channelId) ?? undefined : undefined,
            conversation_id: row.conversationId ?? undefined,
          },
          read: row.read,
          created_at: row.createdAt.toISOString(),
        };
      });

      return { items: formatted, has_more: hasMore };
    }),

  markRead: protectedProcedure
    .input(z.object({ activity_ids: z.array(z.string().uuid()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await requireMember(ctx.db, ctx.serverId, ctx.user.id);
      await ctx.db
        .update(activityItems)
        .set({ read: true })
        .where(and(eq(activityItems.userId, ctx.user.id), inArray(activityItems.id, input.activity_ids)));
      return { success: true };
    }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);
    await ctx.db
      .update(activityItems)
      .set({ read: true })
      .where(and(eq(activityItems.userId, ctx.user.id), eq(activityItems.read, false)));
    return { success: true };
  }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);
    const [result] = await ctx.db
      .select({ value: countFn() })
      .from(activityItems)
      .where(and(eq(activityItems.userId, ctx.user.id), eq(activityItems.read, false)));
    return { count: Number(result?.value ?? 0) };
  }),
});

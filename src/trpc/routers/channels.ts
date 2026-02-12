import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { channels, categories, channelPermissionOverrides } from '../../db/schema/index.js';
import { eq, and, max } from 'drizzle-orm';
import { generateUUIDv7, Permissions, computePermissions, hasPermission } from 'ecto-shared';
import { formatChannel, formatCategory } from '../../utils/format.js';
import { requirePermission, requireMember, buildPermissionContext } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';

export const channelsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);
    const d = ctx.db;

    const [allChannels, allCategories] = await Promise.all([
      d.select().from(channels).where(eq(channels.serverId, ctx.serverId)),
      d.select().from(categories).where(eq(categories.serverId, ctx.serverId)),
    ]);

    // Filter channels by READ_MESSAGES permission
    const visibleChannels: typeof allChannels = [];
    for (const ch of allChannels) {
      const permCtx = await buildPermissionContext(d, ctx.serverId, ctx.user.id, ch.id);
      const effective = computePermissions(permCtx);
      if (hasPermission(effective, Permissions.READ_MESSAGES)) {
        visibleChannels.push(ch);
      }
    }

    // Group by category
    const categoryMap = new Map(allCategories.map((c) => [c.id, { ...formatCategory(c), channels: [] as ReturnType<typeof formatChannel>[] }]));
    const uncategorized: ReturnType<typeof formatChannel>[] = [];

    for (const ch of visibleChannels.sort((a, b) => a.position - b.position)) {
      const formatted = formatChannel(ch);
      if (ch.categoryId && categoryMap.has(ch.categoryId)) {
        categoryMap.get(ch.categoryId)!.channels.push(formatted);
      } else {
        uncategorized.push(formatted);
      }
    }

    const sortedCategories = [...categoryMap.values()].sort((a, b) => a.position - b.position);
    return { categories: sortedCategories, uncategorized };
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        type: z.enum(['text', 'voice']),
        category_id: z.string().uuid().optional(),
        topic: z.string().max(1024).optional(),
        permission_overrides: z
          .array(
            z.object({
              target_type: z.enum(['role', 'member']),
              target_id: z.string().uuid(),
              allow: z.number().int(),
              deny: z.number().int(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);
      const d = ctx.db;

      // Get next position
      const [maxPos] = await d
        .select({ maxPosition: max(channels.position) })
        .from(channels)
        .where(eq(channels.serverId, ctx.serverId));
      const position = (maxPos?.maxPosition ?? -1) + 1;

      const id = generateUUIDv7();
      await d.insert(channels).values({
        id,
        serverId: ctx.serverId,
        categoryId: input.category_id ?? null,
        name: input.name,
        type: input.type,
        topic: input.topic ?? null,
        position,
      });

      // Insert permission overrides
      if (input.permission_overrides?.length) {
        await d.insert(channelPermissionOverrides).values(
          input.permission_overrides.map((o) => ({
            id: generateUUIDv7(),
            channelId: id,
            targetType: o.target_type,
            targetId: o.target_id,
            allow: o.allow,
            deny: o.deny,
          })),
        );
      }

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'channel.create',
        targetType: 'channel',
        targetId: id,
        details: { name: input.name, type: input.type },
      });

      const [row] = await d.select().from(channels).where(eq(channels.id, id)).limit(1);
      const formatted = formatChannel(row!);
      eventDispatcher.dispatchToAll('channel.create', formatted);
      return formatted;
    }),

  update: protectedProcedure
    .input(
      z.object({
        channel_id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        topic: z.string().max(1024).optional(),
        category_id: z.string().uuid().optional(),
        permission_overrides: z
          .array(
            z.object({
              target_type: z.enum(['role', 'member']),
              target_id: z.string().uuid(),
              allow: z.number().int(),
              deny: z.number().int(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);
      const d = ctx.db;

      const [ch] = await d
        .select()
        .from(channels)
        .where(and(eq(channels.id, input.channel_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!ch) throw ectoError('NOT_FOUND', 3000, 'Channel not found');

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) updates['name'] = input.name;
      if (input.topic !== undefined) updates['topic'] = input.topic;
      if (input.category_id !== undefined) updates['categoryId'] = input.category_id;

      await d.update(channels).set(updates).where(eq(channels.id, input.channel_id));

      // Replace overrides if provided
      if (input.permission_overrides) {
        await d.delete(channelPermissionOverrides).where(eq(channelPermissionOverrides.channelId, input.channel_id));
        if (input.permission_overrides.length > 0) {
          await d.insert(channelPermissionOverrides).values(
            input.permission_overrides.map((o) => ({
              id: generateUUIDv7(),
              channelId: input.channel_id,
              targetType: o.target_type,
              targetId: o.target_id,
              allow: o.allow,
              deny: o.deny,
            })),
          );
        }
      }

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'channel.update',
        targetType: 'channel',
        targetId: input.channel_id,
        details: { name: input.name, topic: input.topic },
      });

      const [updated] = await d.select().from(channels).where(eq(channels.id, input.channel_id)).limit(1);
      const updatedFormatted = formatChannel(updated!);
      eventDispatcher.dispatchToAll('channel.update', updatedFormatted);
      return updatedFormatted;
    }),

  delete: protectedProcedure
    .input(z.object({ channel_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);

      const [ch] = await ctx.db
        .select()
        .from(channels)
        .where(and(eq(channels.id, input.channel_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!ch) throw ectoError('NOT_FOUND', 3000, 'Channel not found');

      await ctx.db.delete(channels).where(eq(channels.id, input.channel_id));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'channel.delete',
        targetType: 'channel',
        targetId: input.channel_id,
        details: { name: ch.name },
      });

      eventDispatcher.dispatchToAll('channel.delete', { id: input.channel_id });
      return { success: true };
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        channels: z.array(
          z.object({
            channel_id: z.string().uuid(),
            position: z.number().int().min(0),
            category_id: z.string().uuid().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);
      const d = ctx.db;

      for (const item of input.channels) {
        const updates: Record<string, unknown> = { position: item.position, updatedAt: new Date() };
        if (item.category_id !== undefined) updates['categoryId'] = item.category_id;
        await d.update(channels).set(updates).where(and(eq(channels.id, item.channel_id), eq(channels.serverId, ctx.serverId)));
      }

      return { success: true };
    }),
});

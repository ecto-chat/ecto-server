import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { categories, channels, categoryPermissionOverrides } from '../../db/schema/index.js';
import { eq, and, max } from 'drizzle-orm';
import { generateUUIDv7, Permissions, permissionBitfieldSchema } from 'ecto-shared';
import { formatCategory } from '../../utils/format.js';
import { requirePermission } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';

export const categoriesRouter = router({
  create: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);
      const d = ctx.db;

      const [maxPos] = await d
        .select({ maxPosition: max(categories.position) })
        .from(categories)
        .where(eq(categories.serverId, ctx.serverId));
      const position = (maxPos?.maxPosition ?? -1) + 1;

      const id = generateUUIDv7();
      await d.insert(categories).values({
        id,
        serverId: ctx.serverId,
        name: input.name,
        position,
      });

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'category.create',
        targetType: 'category',
        targetId: id,
        details: { name: input.name },
      });

      const [row] = await d.select().from(categories).where(eq(categories.id, id)).limit(1);
      const formatted = formatCategory(row!);
      eventDispatcher.dispatchToAll('category.create', formatted);
      return formatted;
    }),

  update: protectedProcedure
    .input(z.object({
      category_id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      permission_overrides: z
        .array(
          z.object({
            target_type: z.enum(['role', 'member']),
            target_id: z.string().uuid(),
            allow: permissionBitfieldSchema,
            deny: permissionBitfieldSchema,
          }),
        )
        .optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);
      const d = ctx.db;

      const [cat] = await d
        .select()
        .from(categories)
        .where(and(eq(categories.id, input.category_id), eq(categories.serverId, ctx.serverId)))
        .limit(1);

      if (!cat) throw ectoError('NOT_FOUND', 3000, 'Category not found');

      const formatted = await d.transaction(async (tx) => {
        if (input.name !== undefined) {
          await tx
            .update(categories)
            .set({ name: input.name })
            .where(eq(categories.id, input.category_id));
        }

        // Replace overrides if provided
        if (input.permission_overrides) {
          await tx.delete(categoryPermissionOverrides).where(eq(categoryPermissionOverrides.categoryId, input.category_id));
          if (input.permission_overrides.length > 0) {
            await tx.insert(categoryPermissionOverrides).values(
              input.permission_overrides.map((o) => ({
                id: generateUUIDv7(),
                categoryId: input.category_id,
                targetType: o.target_type,
                targetId: o.target_id,
                allow: o.allow,
                deny: o.deny,
              })),
            );
          }
        }

        await insertAuditLog(tx, {
          serverId: ctx.serverId,
          actorId: ctx.user.id,
          action: 'category.update',
          targetType: 'category',
          targetId: input.category_id,
          details: { name: input.name },
        });

        const [updated] = await tx.select().from(categories).where(eq(categories.id, input.category_id)).limit(1);
        return formatCategory(updated!);
      });

      eventDispatcher.dispatchToAll('category.update', formatted);
      if (input.permission_overrides) {
        eventDispatcher.dispatchToAll('permissions.update', { type: 'category', id: input.category_id });
      }
      return formatted;
    }),

  getOverrides: protectedProcedure
    .input(z.object({ category_id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);
      const overrides = await ctx.db
        .select()
        .from(categoryPermissionOverrides)
        .where(eq(categoryPermissionOverrides.categoryId, input.category_id));
      return overrides.map((o) => ({
        id: o.id,
        category_id: o.categoryId,
        target_type: o.targetType as 'role' | 'member',
        target_id: o.targetId,
        allow: o.allow,
        deny: o.deny,
      }));
    }),

  delete: protectedProcedure
    .input(z.object({ category_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);

      const [cat] = await ctx.db
        .select()
        .from(categories)
        .where(and(eq(categories.id, input.category_id), eq(categories.serverId, ctx.serverId)))
        .limit(1);

      if (!cat) throw ectoError('NOT_FOUND', 3000, 'Category not found');

      // Channels become uncategorized (handled by ON DELETE SET NULL FK)
      await ctx.db.delete(categories).where(eq(categories.id, input.category_id));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'category.delete',
        targetType: 'category',
        targetId: input.category_id,
        details: { name: cat.name },
      });

      eventDispatcher.dispatchToAll('category.delete', { id: input.category_id });
      return { success: true };
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        categories: z.array(z.object({ category_id: z.string().uuid(), position: z.number().int().min(0) })),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_CHANNELS);

      for (const item of input.categories) {
        await ctx.db
          .update(categories)
          .set({ position: item.position })
          .where(and(eq(categories.id, item.category_id), eq(categories.serverId, ctx.serverId)));
      }

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'category.reorder',
        targetType: 'category',
        targetId: ctx.serverId,
        details: { count: input.categories.length },
      });

      const allCategories = await ctx.db
        .select()
        .from(categories)
        .where(eq(categories.serverId, ctx.serverId));
      eventDispatcher.dispatchToAll('category.reorder', allCategories.map(formatCategory));

      return { success: true };
    }),
});

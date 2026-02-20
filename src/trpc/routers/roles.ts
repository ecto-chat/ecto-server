import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { roles, memberRoles } from '../../db/schema/index.js';
import { eq, and, desc, max } from 'drizzle-orm';
import { generateUUIDv7, Permissions } from 'ecto-shared';
import { formatRole } from '../../utils/format.js';
import { requirePermission, requireMember } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';

export const rolesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);
    const rows = await ctx.db
      .select()
      .from(roles)
      .where(eq(roles.serverId, ctx.serverId))
      .orderBy(desc(roles.position));
    return rows.map(formatRole);
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        color: z.string().max(7).optional(),
        permissions: z.number().int().optional(),
        position: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_ROLES);
      const d = ctx.db;

      let position = input.position;
      if (position === undefined) {
        const [maxPos] = await d
          .select({ maxPosition: max(roles.position) })
          .from(roles)
          .where(eq(roles.serverId, ctx.serverId));
        position = (maxPos?.maxPosition ?? 0) + 1;
      }

      const id = generateUUIDv7();
      await d.insert(roles).values({
        id,
        serverId: ctx.serverId,
        name: input.name,
        color: input.color ?? null,
        permissions: input.permissions ?? 0,
        position,
      });

      await insertAuditLog(d, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'role.create',
        targetType: 'role',
        targetId: id,
        details: { name: input.name },
      });

      const [row] = await d.select().from(roles).where(eq(roles.id, id)).limit(1);
      const formatted = formatRole(row!);
      eventDispatcher.dispatchToAll('role.create', formatted);
      return formatted;
    }),

  update: protectedProcedure
    .input(
      z.object({
        role_id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        color: z.string().max(7).optional(),
        permissions: z.number().int().optional(),
        position: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_ROLES);

      const [role] = await ctx.db
        .select()
        .from(roles)
        .where(and(eq(roles.id, input.role_id), eq(roles.serverId, ctx.serverId)))
        .limit(1);

      if (!role) throw ectoError('NOT_FOUND', 5000, 'Role not found');

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates['name'] = input.name;
      if (input.color !== undefined) updates['color'] = input.color;
      if (input.permissions !== undefined) updates['permissions'] = input.permissions;
      if (input.position !== undefined) updates['position'] = input.position;

      await ctx.db.update(roles).set(updates).where(eq(roles.id, input.role_id));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'role.update',
        targetType: 'role',
        targetId: input.role_id,
        details: input as Record<string, unknown>,
      });

      const [updated] = await ctx.db.select().from(roles).where(eq(roles.id, input.role_id)).limit(1);
      const formatted = formatRole(updated!);
      eventDispatcher.dispatchToAll('role.update', formatted);
      return formatted;
    }),

  delete: protectedProcedure
    .input(z.object({ role_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_ROLES);

      const [role] = await ctx.db
        .select()
        .from(roles)
        .where(and(eq(roles.id, input.role_id), eq(roles.serverId, ctx.serverId)))
        .limit(1);

      if (!role) throw ectoError('NOT_FOUND', 5000, 'Role not found');
      if (role.isDefault) throw ectoError('FORBIDDEN', 5001, 'Cannot delete the @everyone role');

      await ctx.db.delete(roles).where(eq(roles.id, input.role_id));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'role.delete',
        targetType: 'role',
        targetId: input.role_id,
        details: { name: role.name },
      });

      eventDispatcher.dispatchToAll('role.delete', { id: input.role_id });
      return { success: true };
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        roles: z.array(z.object({ role_id: z.string().uuid(), position: z.number().int().min(0) })),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_ROLES);

      for (const item of input.roles) {
        await ctx.db
          .update(roles)
          .set({ position: item.position })
          .where(and(eq(roles.id, item.role_id), eq(roles.serverId, ctx.serverId)));
      }

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'role.reorder',
        targetType: 'role',
        targetId: ctx.serverId,
        details: { count: input.roles.length },
      });

      const allRoles = await ctx.db
        .select()
        .from(roles)
        .where(eq(roles.serverId, ctx.serverId))
        .orderBy(desc(roles.position));
      eventDispatcher.dispatchToAll('role.reorder', allRoles.map(formatRole));

      return { success: true };
    }),
});

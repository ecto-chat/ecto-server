import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { auditLog } from '../../db/schema/index.js';
import { eq, and, lt, desc } from 'drizzle-orm';
import { Permissions } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { formatAuditLogEntry } from '../../utils/format.js';
import { resolveUserProfiles } from '../../utils/resolve-profile.js';

export const auditLogRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        before: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        action: z.string().optional(),
        actor_id: z.string().uuid().optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.VIEW_AUDIT_LOG);
      const d = ctx.db;
      const limit = input?.limit ?? 50;

      const conditions = [eq(auditLog.serverId, ctx.serverId)];
      if (input?.before) conditions.push(lt(auditLog.id, input.before));
      if (input?.action) conditions.push(eq(auditLog.action, input.action));
      if (input?.actor_id) conditions.push(eq(auditLog.actorId, input.actor_id));

      const rows = await d
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.id))
        .limit(limit + 1);

      const has_more = rows.length > limit;
      const entries = has_more ? rows.slice(0, limit) : rows;

      const actorIds = [...new Set(entries.map((e) => e.actorId))];
      const profiles = await resolveUserProfiles(d, actorIds);

      return {
        entries: entries.map((e) => {
          const actorName = profiles.get(e.actorId)?.username ?? 'Unknown';
          return formatAuditLogEntry(e, actorName);
        }),
        has_more,
      };
    }),
});

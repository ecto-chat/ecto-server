import { z } from 'zod/v4';
import { randomBytes } from 'node:crypto';
import { router, protectedProcedure } from '../init.js';
import { webhooks, channels } from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { generateUUIDv7, Permissions } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';

export const webhooksRouter = router({
  create: protectedProcedure
    .input(z.object({
      channel_id: z.string().uuid(),
      name: z.string().min(1).max(80),
      avatar_url: z.string().url().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_WEBHOOKS);

      // Verify channel exists
      const [channel] = await ctx.db
        .select()
        .from(channels)
        .where(and(eq(channels.id, input.channel_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!channel) throw ectoError('NOT_FOUND', 3000, 'Channel not found');

      const id = generateUUIDv7();
      const token = randomBytes(32).toString('hex');

      await ctx.db.insert(webhooks).values({
        id,
        channelId: input.channel_id,
        name: input.name,
        avatarUrl: input.avatar_url ?? null,
        token,
        createdBy: ctx.user.id,
      });

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'webhook.create',
        targetType: 'webhook',
        targetId: id,
        details: { name: input.name, channel_id: input.channel_id },
      });

      const [row] = await ctx.db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
      return formatWebhook(row!);
    }),

  list: protectedProcedure
    .input(z.object({ channel_id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_WEBHOOKS);

      // Verify channel belongs to this server
      const [ch] = await ctx.db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.id, input.channel_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);
      if (!ch) throw ectoError('NOT_FOUND', 3000, 'Channel not found');

      const rows = await ctx.db
        .select()
        .from(webhooks)
        .where(eq(webhooks.channelId, input.channel_id));

      return rows.map(formatWebhook);
    }),

  delete: protectedProcedure
    .input(z.object({ webhook_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_WEBHOOKS);

      // Verify webhook belongs to this server via channel join
      const [webhook] = await ctx.db
        .select({ id: webhooks.id, channelId: webhooks.channelId, name: webhooks.name })
        .from(webhooks)
        .innerJoin(channels, eq(webhooks.channelId, channels.id))
        .where(and(eq(webhooks.id, input.webhook_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!webhook) throw ectoError('NOT_FOUND', 4000, 'Webhook not found');

      await ctx.db.delete(webhooks).where(eq(webhooks.id, input.webhook_id));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'webhook.delete',
        targetType: 'webhook',
        targetId: input.webhook_id,
        details: { name: webhook.name },
      });

      return { success: true };
    }),

  regenerateToken: protectedProcedure
    .input(z.object({ webhook_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_WEBHOOKS);

      // Verify webhook belongs to this server via channel join
      const [webhook] = await ctx.db
        .select({ id: webhooks.id, name: webhooks.name })
        .from(webhooks)
        .innerJoin(channels, eq(webhooks.channelId, channels.id))
        .where(and(eq(webhooks.id, input.webhook_id), eq(channels.serverId, ctx.serverId)))
        .limit(1);

      if (!webhook) throw ectoError('NOT_FOUND', 4000, 'Webhook not found');

      const newToken = randomBytes(32).toString('hex');
      await ctx.db
        .update(webhooks)
        .set({ token: newToken })
        .where(eq(webhooks.id, input.webhook_id));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'webhook.update',
        targetType: 'webhook',
        targetId: input.webhook_id,
        details: { token_regenerated: true },
      });

      const [updated] = await ctx.db.select().from(webhooks).where(eq(webhooks.id, input.webhook_id)).limit(1);
      return formatWebhook(updated!);
    }),
});

function formatWebhook(row: typeof webhooks.$inferSelect) {
  return {
    id: row.id,
    channel_id: row.channelId,
    name: row.name,
    avatar_url: row.avatarUrl,
    token: row.token,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}

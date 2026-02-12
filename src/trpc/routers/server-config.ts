import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { serverConfig } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { Permissions } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';

export const serverConfigRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_SERVER);

    const [cfg] = await ctx.db
      .select()
      .from(serverConfig)
      .where(eq(serverConfig.serverId, ctx.serverId))
      .limit(1);

    if (!cfg) throw ectoError('NOT_FOUND', 2000, 'Server config not found');

    return {
      max_upload_size_bytes: cfg.maxUploadSizeBytes,
      allow_local_accounts: cfg.allowLocalAccounts,
      require_invite: cfg.requireInvite,
      allow_member_dms: cfg.allowMemberDms,
      version: '0.1.0',
    };
  }),

  update: protectedProcedure
    .input(
      z.object({
        max_upload_size_bytes: z.number().int().min(0).optional(),
        allow_local_accounts: z.boolean().optional(),
        require_invite: z.boolean().optional(),
        allow_member_dms: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_SERVER);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.max_upload_size_bytes !== undefined) updates['maxUploadSizeBytes'] = input.max_upload_size_bytes;
      if (input.allow_local_accounts !== undefined) updates['allowLocalAccounts'] = input.allow_local_accounts;
      if (input.require_invite !== undefined) updates['requireInvite'] = input.require_invite;
      if (input.allow_member_dms !== undefined) updates['allowMemberDms'] = input.allow_member_dms;

      await ctx.db.update(serverConfig).set(updates).where(eq(serverConfig.serverId, ctx.serverId));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'server.update',
        targetType: 'server',
        targetId: ctx.serverId,
        details: { config: input },
      });

      return { success: true };
    }),
});

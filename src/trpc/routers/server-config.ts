import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { serverConfig, servers } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { Permissions } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { formatServer } from '../../utils/format.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';
import { registerDiscoverableServer, unregisterFromCentralDiscovery } from '../../services/central-news-sync.js';

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
      max_shared_storage_bytes: cfg.maxSharedStorageBytes,
      allow_local_accounts: cfg.allowLocalAccounts,
      require_invite: cfg.requireInvite,
      allow_member_dms: cfg.allowMemberDms,
      show_system_messages: cfg.showSystemMessages,
      discoverable: cfg.discoverable,
      discovery_approved: cfg.discoveryApproved,
      tags: (cfg.tags as string[] | null) ?? [],
      version: '0.1.0',
    };
  }),

  update: protectedProcedure
    .input(
      z.object({
        max_upload_size_bytes: z.number().int().min(0).optional(),
        max_shared_storage_bytes: z.number().int().min(0).optional(),
        allow_local_accounts: z.boolean().optional(),
        require_invite: z.boolean().optional(),
        allow_member_dms: z.boolean().optional(),
        show_system_messages: z.boolean().optional(),
        discoverable: z.boolean().optional(),
        tags: z.array(z.string().max(30).transform((s) => s.trim().toLowerCase())).max(10).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_SERVER);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.max_upload_size_bytes !== undefined) updates['maxUploadSizeBytes'] = input.max_upload_size_bytes;
      if (input.max_shared_storage_bytes !== undefined) updates['maxSharedStorageBytes'] = input.max_shared_storage_bytes;
      if (input.allow_local_accounts !== undefined) updates['allowLocalAccounts'] = input.allow_local_accounts;
      if (input.require_invite !== undefined) updates['requireInvite'] = input.require_invite;
      if (input.allow_member_dms !== undefined) updates['allowMemberDms'] = input.allow_member_dms;
      if (input.show_system_messages !== undefined) updates['showSystemMessages'] = input.show_system_messages;
      if (input.discoverable !== undefined) updates['discoverable'] = input.discoverable;
      if (input.tags !== undefined) updates['tags'] = input.tags;

      await ctx.db.update(serverConfig).set(updates).where(eq(serverConfig.serverId, ctx.serverId));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'server.update',
        targetType: 'server',
        targetId: ctx.serverId,
        details: { config: input },
      });

      // Register/unregister with central discovery when discoverable or tags change
      const [serverRow] = await ctx.db.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);
      if (serverRow && (input.discoverable !== undefined || input.tags !== undefined)) {
        const [currentCfg] = await ctx.db.select().from(serverConfig).where(eq(serverConfig.serverId, ctx.serverId)).limit(1);
        const isDiscoverable = currentCfg?.discoverable ?? false;

        if (isDiscoverable) {
          // Server is discoverable — (re-)register to sync latest data + tags
          const approved = await registerDiscoverableServer({
            server_id: ctx.serverId,
            address: serverRow.address ?? '',
            name: serverRow.name,
            description: serverRow.description,
            icon_url: serverRow.iconUrl,
            banner_url: serverRow.bannerUrl,
            tags: (currentCfg?.tags as string[] | null) ?? [],
          });
          if (approved !== null) {
            await ctx.db.update(serverConfig).set({ discoveryApproved: approved, updatedAt: new Date() }).where(eq(serverConfig.serverId, ctx.serverId));
          }
        } else if (input.discoverable === false) {
          // Just turned off discoverable — unregister
          unregisterFromCentralDiscovery(ctx.serverId);
          await ctx.db.update(serverConfig).set({ discoveryApproved: false, updatedAt: new Date() }).where(eq(serverConfig.serverId, ctx.serverId));
        }
      }

      // Single broadcast with final state (after discovery registration if applicable)
      const [finalCfg] = await ctx.db.select().from(serverConfig).where(eq(serverConfig.serverId, ctx.serverId)).limit(1);
      if (serverRow) {
        eventDispatcher.dispatchToServer(ctx.serverId, 'server.update', formatServer(serverRow, finalCfg));
      }

      return { success: true };
    }),

  completeSetup: protectedProcedure.mutation(async ({ ctx }) => {
    const d = ctx.db;
    const [server] = await d
      .select({ adminUserId: servers.adminUserId })
      .from(servers)
      .where(eq(servers.id, ctx.serverId))
      .limit(1);

    if (!server || server.adminUserId !== ctx.user.id) {
      throw ectoError('FORBIDDEN', 1006, 'Only the server admin can complete setup');
    }

    await d
      .update(serverConfig)
      .set({ setupCompleted: true, updatedAt: new Date() })
      .where(eq(serverConfig.serverId, ctx.serverId));

    await insertAuditLog(d, {
      serverId: ctx.serverId,
      actorId: ctx.user.id,
      action: 'server.update',
      targetType: 'server',
      targetId: ctx.serverId,
      details: { setup_completed: true },
    });

    // Broadcast full server object so clients see setup_completed: true
    const [serverRow] = await d.select().from(servers).where(eq(servers.id, ctx.serverId)).limit(1);
    const [updatedCfg] = await d.select().from(serverConfig).where(eq(serverConfig.serverId, ctx.serverId)).limit(1);
    if (serverRow) {
      eventDispatcher.dispatchToServer(ctx.serverId, 'server.update', formatServer(serverRow, updatedCfg));
    }

    return { success: true };
  }),
});

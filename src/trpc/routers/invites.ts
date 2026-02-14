import { z } from 'zod/v4';
import { router, protectedProcedure } from '../init.js';
import { invites } from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { generateUUIDv7, Permissions } from 'ecto-shared';
import { requirePermission, requireMember } from '../../utils/permission-context.js';
import { insertAuditLog } from '../../utils/audit-log.js';
import { ectoError } from '../../utils/errors.js';
import { generateInviteCode } from '../../utils/invite-code.js';
import { formatInvite } from '../../utils/format.js';
import { resolveUserProfiles } from '../../utils/resolve-profile.js';
import { eventDispatcher } from '../../ws/event-dispatcher.js';

export const invitesRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        max_uses: z.number().int().min(1).nullable().optional(),
        expires_in: z.number().int().min(60000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.CREATE_INVITES);

      const code = generateInviteCode();
      const id = generateUUIDv7();
      const expiresAt = input.expires_in ? new Date(Date.now() + input.expires_in) : null;

      await ctx.db.insert(invites).values({
        id,
        serverId: ctx.serverId,
        code,
        createdBy: ctx.user.id,
        maxUses: input.max_uses ?? null,
        expiresAt,
      });

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'invite.create',
        targetType: 'invite',
        targetId: id,
        details: { code, max_uses: input.max_uses, expires_in: input.expires_in },
      });

      const [row] = await ctx.db.select().from(invites).where(eq(invites.id, id)).limit(1);
      const profiles = await resolveUserProfiles(ctx.db, [ctx.user.id]);
      const profile = profiles.get(ctx.user.id);

      const invite = formatInvite(row!, profile?.username ?? 'Unknown');
      eventDispatcher.dispatchToAll('invite.create', invite);
      return {
        invite,
        url: `ecto://${code}`,
      };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);

    const rows = await ctx.db.select().from(invites).where(eq(invites.serverId, ctx.serverId));
    const creatorIds = [...new Set(rows.map((r) => r.createdBy))];
    const profiles = await resolveUserProfiles(ctx.db, creatorIds);

    return rows.map((r) => {
      const profile = profiles.get(r.createdBy);
      return formatInvite(r, profile?.username ?? 'Unknown');
    });
  }),

  revoke: protectedProcedure
    .input(z.object({ invite_id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [invite] = await ctx.db
        .select()
        .from(invites)
        .where(and(eq(invites.id, input.invite_id), eq(invites.serverId, ctx.serverId)))
        .limit(1);

      if (!invite) throw ectoError('NOT_FOUND', 2004, 'Invite not found');

      if (invite.createdBy !== ctx.user.id) {
        await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.MANAGE_SERVER);
      }

      await ctx.db.update(invites).set({ revoked: true }).where(eq(invites.id, input.invite_id));

      await insertAuditLog(ctx.db, {
        serverId: ctx.serverId,
        actorId: ctx.user.id,
        action: 'invite.revoke',
        targetType: 'invite',
        targetId: input.invite_id,
      });

      eventDispatcher.dispatchToAll('invite.delete', { id: input.invite_id });
      return { success: true };
    }),
});

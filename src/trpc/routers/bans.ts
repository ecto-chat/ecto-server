import { router, protectedProcedure } from '../init.js';
import { bans } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { Permissions } from 'ecto-shared';
import { requirePermission } from '../../utils/permission-context.js';
import { formatBan } from '../../utils/format.js';
import { resolveUserProfiles } from '../../utils/resolve-profile.js';

export const bansRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requirePermission(ctx.db, ctx.serverId, ctx.user.id, Permissions.BAN_MEMBERS);

    const rows = await ctx.db.select().from(bans).where(eq(bans.serverId, ctx.serverId));
    const userIds = [...new Set([...rows.map((r) => r.userId), ...rows.map((r) => r.bannedBy)])];
    const profiles = await resolveUserProfiles(ctx.db, userIds);

    return rows.map((r) => {
      const username = profiles.get(r.userId)?.username ?? 'Unknown';
      const bannedByName = profiles.get(r.bannedBy)?.username ?? 'Unknown';
      return formatBan(r, username, bannedByName);
    });
  }),
});

import { router, protectedProcedure } from '../init.js';
import { requireMember } from '../../utils/permission-context.js';

export const serverDmsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);
    // Server DMs are handled via server.dms.list
    return [];
  }),

  get: protectedProcedure.query(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);
    return null;
  }),

  send: protectedProcedure.mutation(async ({ ctx }) => {
    await requireMember(ctx.db, ctx.serverId, ctx.user.id);
    return null;
  }),
});

import { router, protectedProcedure } from '../router.js';

export const invitesRouter = router({
  list: protectedProcedure.query(async () => {
    // TODO
  }),
  create: protectedProcedure.mutation(async () => {
    // TODO
  }),
  revoke: protectedProcedure.mutation(async () => {
    // TODO
  }),
  join: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

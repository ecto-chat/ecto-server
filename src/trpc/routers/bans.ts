import { router, protectedProcedure } from '../router.js';

export const bansRouter = router({
  list: protectedProcedure.query(async () => {
    // TODO
  }),
  create: protectedProcedure.mutation(async () => {
    // TODO
  }),
  remove: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

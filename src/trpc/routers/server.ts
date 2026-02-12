import { router, protectedProcedure } from '../router.js';

export const serverRouter = router({
  getInfo: protectedProcedure.query(async () => {
    // TODO
  }),
  update: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

import { router, protectedProcedure } from '../router.js';

export const serverConfigRouter = router({
  get: protectedProcedure.query(async () => {
    // TODO
  }),
  update: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

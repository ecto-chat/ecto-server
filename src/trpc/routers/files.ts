import { router, protectedProcedure } from '../router.js';

export const filesRouter = router({
  upload: protectedProcedure.mutation(async () => {
    // TODO
  }),
  getUrl: protectedProcedure.query(async () => {
    // TODO
  }),
});

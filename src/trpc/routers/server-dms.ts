import { router, protectedProcedure } from '../router.js';

export const serverDmsRouter = router({
  list: protectedProcedure.query(async () => {
    // TODO
  }),
  get: protectedProcedure.query(async () => {
    // TODO
  }),
  send: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

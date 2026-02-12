import { router, protectedProcedure } from '../router.js';

export const channelsRouter = router({
  list: protectedProcedure.query(async () => {
    // TODO
  }),
  create: protectedProcedure.mutation(async () => {
    // TODO
  }),
  update: protectedProcedure.mutation(async () => {
    // TODO
  }),
  delete: protectedProcedure.mutation(async () => {
    // TODO
  }),
  reorder: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

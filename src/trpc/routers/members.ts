import { router, protectedProcedure } from '../router.js';

export const membersRouter = router({
  list: protectedProcedure.query(async () => {
    // TODO
  }),
  get: protectedProcedure.query(async () => {
    // TODO
  }),
  kick: protectedProcedure.mutation(async () => {
    // TODO
  }),
  updateNickname: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

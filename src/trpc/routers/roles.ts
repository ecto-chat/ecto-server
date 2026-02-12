import { router, protectedProcedure } from '../router.js';

export const rolesRouter = router({
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
  assignToMember: protectedProcedure.mutation(async () => {
    // TODO
  }),
  removeFromMember: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

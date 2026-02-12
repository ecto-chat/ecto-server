import { router, protectedProcedure } from '../router.js';

export const readStateRouter = router({
  ack: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

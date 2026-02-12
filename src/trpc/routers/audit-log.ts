import { router, protectedProcedure } from '../router.js';

export const auditLogRouter = router({
  list: protectedProcedure.query(async () => {
    // TODO
  }),
});

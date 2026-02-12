import { router, protectedProcedure } from '../router.js';

export const messagesRouter = router({
  send: protectedProcedure.mutation(async () => {
    // TODO
  }),
  edit: protectedProcedure.mutation(async () => {
    // TODO
  }),
  delete: protectedProcedure.mutation(async () => {
    // TODO
  }),
  get: protectedProcedure.query(async () => {
    // TODO
  }),
  getPinned: protectedProcedure.query(async () => {
    // TODO
  }),
  pin: protectedProcedure.mutation(async () => {
    // TODO
  }),
  unpin: protectedProcedure.mutation(async () => {
    // TODO
  }),
  addReaction: protectedProcedure.mutation(async () => {
    // TODO
  }),
  removeReaction: protectedProcedure.mutation(async () => {
    // TODO
  }),
});

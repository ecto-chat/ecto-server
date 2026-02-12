import { TRPCError } from '@trpc/server';

export async function verifyToken(_token: string) {
  // TODO: Verify JWT, return user payload
  throw new TRPCError({ code: 'UNAUTHORIZED' });
}

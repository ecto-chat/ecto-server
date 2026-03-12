import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/unstable-core-do-not-import';
import { EctoErrorIdentifier } from 'ecto-shared';

export function ectoError(
  trpcCode: TRPC_ERROR_CODE_KEY,
  ectoCode: number,
  message: string,
): TRPCError {
  return new TRPCError({
    code: trpcCode,
    message,
    cause: { ecto_code: ectoCode, ecto_error: EctoErrorIdentifier[ectoCode] ?? 'unknown_error' },
  });
}

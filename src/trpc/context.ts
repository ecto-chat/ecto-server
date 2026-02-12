import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';

export async function createContext(_opts: CreateHTTPContextOptions) {
  // TODO: Extract auth token, resolve user, attach db
  return {
    user: null as { id: string; identity_type: 'global' | 'local' } | null,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

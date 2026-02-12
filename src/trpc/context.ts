import type { CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';
import { verifyToken, type AuthUser } from '../middleware/auth.js';
import { db, type Db } from '../db/index.js';

export interface Context {
  user: AuthUser | null;
  db: Db;
  serverId: string;
}

let _serverId: string | null = null;

export function setServerId(id: string) {
  _serverId = id;
}

export async function createContext(opts: CreateHTTPContextOptions): Promise<Context> {
  let user: AuthUser | null = null;

  const authHeader = opts.req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      user = await verifyToken(token);
    } catch {
      // Invalid token — proceed as unauthenticated
    }
  }

  return {
    user,
    db: db(),
    serverId: _serverId!,
  };
}

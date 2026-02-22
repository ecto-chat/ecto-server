import type http from 'node:http';
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

export function getServerId(): string {
  return _serverId!;
}

/**
 * Pluggable server resolver for multi-tenant mode.
 * When set, resolves serverId from request Host header instead of using the singleton.
 */
export type ServerResolver = (req: http.IncomingMessage) => Promise<string>;

let _serverResolver: ServerResolver | null = null;

export function setServerResolver(resolver: ServerResolver) {
  _serverResolver = resolver;
}

/**
 * Resolve serverId from a request. Uses the pluggable resolver if set (multi-tenant),
 * otherwise falls back to the singleton (self-hosted).
 */
export async function resolveServerId(req: http.IncomingMessage): Promise<string> {
  if (_serverResolver) {
    return _serverResolver(req);
  }
  return _serverId!;
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

  const serverId = _serverResolver
    ? await _serverResolver(opts.req)
    : _serverId!;

  return {
    user,
    db: db(),
    serverId,
  };
}

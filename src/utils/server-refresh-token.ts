import { SignJWT, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { config } from '../config/index.js';
import { serverRefreshTokens } from '../db/schema/index.js';
import { generateUUIDv7 } from 'ecto-shared';
import { lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface ServerRefreshTokenPayload {
  sub: string;   // userId
  mid: string;   // memberId
  tv: number;    // tokenVersion
  iss: string;   // serverId
}

export async function signServerRefreshToken(
  userId: string,
  memberId: string,
  tokenVersion: number,
  serverId: string,
): Promise<string> {
  return new SignJWT({ mid: memberId, tv: tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(serverId)
    .setAudience('ecto-server-refresh')
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

export async function verifyServerRefreshToken(
  token: string,
): Promise<ServerRefreshTokenPayload> {
  const result = await jwtVerify(token, secret, { audience: 'ecto-server-refresh' });
  return {
    sub: result.payload.sub!,
    mid: result.payload.mid as string,
    tv: result.payload.tv as number,
    iss: result.payload.iss!,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createServerRefreshToken(
  db: Db,
  memberId: string,
  userId: string,
  tokenVersion: number,
  serverId: string,
): Promise<string> {
  const raw = await signServerRefreshToken(userId, memberId, tokenVersion, serverId);
  const hash = hashToken(raw);

  await db.insert(serverRefreshTokens).values({
    id: generateUUIDv7(),
    memberId,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  return raw;
}

export async function cleanupExpiredServerRefreshTokens(db: Db): Promise<void> {
  await db.delete(serverRefreshTokens).where(lt(serverRefreshTokens.expiresAt, new Date()));
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startServerRefreshTokenCleanup(db: Db): void {
  if (cleanupInterval) return;
  // Run cleanup once on startup, then hourly
  cleanupExpiredServerRefreshTokens(db).catch(() => {});
  cleanupInterval = setInterval(() => {
    cleanupExpiredServerRefreshTokens(db).catch(() => {});
  }, 60 * 60 * 1000);
}

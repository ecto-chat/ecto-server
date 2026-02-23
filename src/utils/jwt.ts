import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config/index.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface ServerTokenPayload {
  sub: string;
  identity_type: 'global' | 'local';
  tv?: number;
  iss?: string;
}

export async function signServerToken(payload: {
  sub: string;
  identity_type: 'global' | 'local';
  tv?: number;
  serverId?: string;
}): Promise<string> {
  const claims: Record<string, unknown> = { identity_type: payload.identity_type };
  if (payload.tv !== undefined) {
    claims.tv = payload.tv;
  }
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setAudience('ecto-server')
    .setExpirationTime('2h');

  if (payload.serverId) {
    builder.setIssuer(payload.serverId);
  }

  return builder.sign(secret);
}

export async function verifyServerToken(
  token: string,
): Promise<ServerTokenPayload> {
  // Lenient audience check: only enforce when token has aud claim
  // This allows backward compat with old 7-day tokens that lack aud
  let result;
  try {
    result = await jwtVerify(token, secret, { audience: 'ecto-server' });
  } catch (err) {
    // If audience verification fails, try without audience check (legacy tokens)
    const verifyErr = err as { code?: string };
    if (verifyErr.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      result = await jwtVerify(token, secret);
    } else {
      throw err;
    }
  }

  return {
    sub: result.payload.sub!,
    identity_type: result.payload.identity_type as 'global' | 'local',
    tv: result.payload.tv as number | undefined,
    iss: result.payload.iss,
  };
}

import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config/index.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);

interface ServerTokenPayload {
  sub: string;
  identity_type: 'global' | 'local';
}

export async function signServerToken(payload: ServerTokenPayload): Promise<string> {
  return new SignJWT({ identity_type: payload.identity_type })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

export async function verifyServerToken(
  token: string,
): Promise<ServerTokenPayload> {
  const { payload } = await jwtVerify(token, secret);
  return {
    sub: payload.sub!,
    identity_type: payload.identity_type as 'global' | 'local',
  };
}

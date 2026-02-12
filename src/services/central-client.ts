import { config } from '../config/index.js';

interface CentralVerifyResult {
  user_id: string;
  username: string;
  discriminator: string;
  display_name: string | null;
  avatar_url: string | null;
}

const verifyCache = new Map<string, { result: CentralVerifyResult; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function centralVerifyToken(token: string): Promise<CentralVerifyResult> {
  const cached = verifyCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  if (!config.CENTRAL_URL) {
    throw new Error('CENTRAL_URL not configured');
  }

  const res = await fetch(`${config.CENTRAL_URL}/api/verify-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    throw new Error(`Central verification failed: ${res.status}`);
  }

  const body = (await res.json()) as {
    valid: boolean;
    user_id?: string;
    tag?: string;
    display_name?: string | null;
    avatar_url?: string | null;
    error?: string;
  };

  if (!body.valid || !body.user_id || !body.tag) {
    throw new Error(body.error ?? 'Token verification failed');
  }

  const [username, discriminator] = body.tag.split('#');

  const result: CentralVerifyResult = {
    user_id: body.user_id,
    username: username!,
    discriminator: discriminator!,
    display_name: body.display_name ?? null,
    avatar_url: body.avatar_url ?? null,
  };

  verifyCache.set(token, { result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}

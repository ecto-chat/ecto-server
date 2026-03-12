import { createHmac } from 'node:crypto';
import { config } from '../config/index.js';

/** Build HMAC-signed headers for outbound calls to central. */
function signedHeaders(body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', config.CENTRAL_SYNC_KEY!)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Signature': signature,
    'X-Timestamp': timestamp,
  };
}

/**
 * Fire-and-forget registration of an invite code with central.
 * Only runs when CENTRAL_URL + CENTRAL_SYNC_KEY are configured (managed mode).
 * Errors are swallowed — this never blocks the calling mutation.
 */
export function registerInviteWithCentral(
  code: string,
  serverId: string,
  address: string,
  expiresAt?: Date | null,
): void {
  if (!config.CENTRAL_URL || !config.CENTRAL_SYNC_KEY) return;

  const body = JSON.stringify({
    code,
    server_id: serverId,
    address,
    expires_at: expiresAt?.toISOString() ?? null,
  });

  fetch(`${config.CENTRAL_URL}/api/invite-register`, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
  }).catch(() => {
    // Swallow — sync is best-effort
  });
}

/**
 * Fire-and-forget unregistration of an invite code from central.
 * Errors are swallowed — this never blocks the calling mutation.
 */
export function unregisterInviteFromCentral(code: string, serverId: string): void {
  if (!config.CENTRAL_URL || !config.CENTRAL_SYNC_KEY) return;

  const body = JSON.stringify({
    code,
    server_id: serverId,
  });

  fetch(`${config.CENTRAL_URL}/api/invite-unregister`, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
  }).catch(() => {
    // Swallow — sync is best-effort
  });
}

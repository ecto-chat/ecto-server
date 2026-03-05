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
 * Sync a news post to central discovery.
 * Returns validation errors from central (if any), or null on success/skip.
 */
export async function syncNewsPostToCentral(data: {
  id: string;
  server_id: string;
  server_address: string;
  server_name: string;
  server_icon_url: string | null;
  author_id: string;
  author_name: string;
  author_avatar_url: string | null;
  title: string;
  subtitle: string | null;
  hero_image_url: string | null;
  published_at: string;
}): Promise<string[] | null> {
  if (!config.CENTRAL_URL || !config.CENTRAL_SYNC_KEY) return null;

  try {
    const body = JSON.stringify(data);
    const res = await fetch(`${config.CENTRAL_URL}/api/discovery-post-sync`, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });

    if (res.ok) {
      const json = await res.json() as { ok?: boolean; validation_errors?: string[] | null };
      return json.validation_errors ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget delete of a news post from central discovery.
 */
export function deleteNewsPostFromCentral(postId: string): void {
  if (!config.CENTRAL_URL || !config.CENTRAL_SYNC_KEY) return;

  const body = JSON.stringify({ post_id: postId });
  fetch(`${config.CENTRAL_URL}/api/discovery-post-delete`, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
  }).catch(() => {
    // Swallow — sync is best-effort
  });
}

/**
 * Unregister a server from central discovery (when discoverable is turned off).
 * Fire-and-forget — errors are swallowed.
 */
export function unregisterFromCentralDiscovery(serverId: string): void {
  if (!config.CENTRAL_URL || !config.CENTRAL_SYNC_KEY) return;

  const body = JSON.stringify({ server_id: serverId });
  fetch(`${config.CENTRAL_URL}/api/discovery-unregister`, {
    method: 'POST',
    headers: signedHeaders(body),
    body,
  }).catch(() => {
    // Swallow — sync is best-effort
  });
}

/**
 * Register a discoverable server with central.
 * Returns the `approved` status from central, or `null` on error/skip.
 */
export async function registerDiscoverableServer(data: {
  server_id: string;
  address: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  banner_url: string | null;
}): Promise<boolean | null> {
  if (!config.CENTRAL_URL || !config.CENTRAL_SYNC_KEY) return null;

  try {
    const body = JSON.stringify(data);
    const res = await fetch(`${config.CENTRAL_URL}/api/discovery-register`, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });

    if (res.ok) {
      const json = await res.json() as { ok?: boolean; approved?: boolean };
      return json.approved ?? false;
    }
    return null;
  } catch {
    return null;
  }
}

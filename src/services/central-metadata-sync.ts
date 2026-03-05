import { createHmac } from 'node:crypto';
import type { Server } from 'ecto-shared';
import { config } from '../config/index.js';

/**
 * Fire-and-forget sync of server metadata to central.
 * Only runs in managed mode with CENTRAL_URL configured.
 * Errors are swallowed — this never blocks the calling mutation.
 */
export function syncServerMetadataToCentral(server: Server): void {
  if (!config.CENTRAL_URL || !config.CENTRAL_SYNC_KEY) return;

  const body = JSON.stringify({
    server_id: server.id,
    address: server.address,
    name: server.name,
    description: server.description,
    icon_url: server.icon_url,
    banner_url: server.banner_url,
    default_channel_id: server.default_channel_id,
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', config.CENTRAL_SYNC_KEY)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  fetch(`${config.CENTRAL_URL}/api/server-metadata-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature,
      'X-Timestamp': timestamp,
    },
    body,
  }).catch(() => {
    // Swallow — sync is best-effort
  });
}

import type { Server } from 'ecto-shared';
import { config } from '../config/index.js';

/**
 * Fire-and-forget sync of server metadata to central.
 * Only runs in managed mode with CENTRAL_URL configured.
 * Errors are swallowed — this never blocks the calling mutation.
 */
export function syncServerMetadataToCentral(server: Server): void {
  if (config.HOSTING_MODE !== 'managed' || !config.CENTRAL_URL) return;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.CENTRAL_SYNC_KEY) {
    headers['Authorization'] = `Bearer ${config.CENTRAL_SYNC_KEY}`;
  }

  fetch(`${config.CENTRAL_URL}/api/server-metadata-sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      server_id: server.id,
      address: server.address,
      name: server.name,
      description: server.description,
      icon_url: server.icon_url,
      banner_url: server.banner_url,
      default_channel_id: server.default_channel_id,
    }),
  }).catch(() => {
    // Swallow — sync is best-effort
  });
}

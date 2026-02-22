import { sql } from 'drizzle-orm';
import { config } from '../config/index.js';
import { db } from '../db/index.js';

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

export function isImageMime(contentType: string): boolean {
  return IMAGE_MIMES.has(contentType);
}

/**
 * Check whether adding `fileSize` bytes would exceed the server's storage quota.
 * Images are exempt from the quota.
 * Returns null if OK, or an error message if quota exceeded.
 */
export async function checkStorageQuota(
  serverId: string,
  fileSize: number,
  contentType: string,
): Promise<string | null> {
  // No global quota configured — skip
  if (config.STORAGE_QUOTA_BYTES <= 0) return null;

  // Images are exempt from quota
  if (isImageMime(contentType)) return null;

  const d = db();

  // Sum non-image bytes across attachments (via channels) and shared_files for this server
  const result = await d.execute(sql`
    SELECT COALESCE(att_bytes, 0) + COALESCE(sf_bytes, 0) AS total_bytes
    FROM (
      SELECT SUM(a.size_bytes) AS att_bytes
      FROM attachments a
      JOIN messages m ON a.message_id = m.id
      JOIN channels c ON m.channel_id = c.id
      WHERE c.server_id = ${serverId}
        AND a.content_type NOT IN ('image/png','image/jpeg','image/gif','image/webp','image/svg+xml')
    ) att
    CROSS JOIN (
      SELECT SUM(sf.size_bytes) AS sf_bytes
      FROM shared_files sf
      WHERE sf.server_id = ${serverId}
        AND sf.content_type NOT IN ('image/png','image/jpeg','image/gif','image/webp','image/svg+xml')
    ) sf
  `);

  const rows = result as unknown as { total_bytes: string | null }[];
  const totalUsed = Number(rows[0]?.total_bytes ?? 0);

  if (totalUsed + fileSize > config.STORAGE_QUOTA_BYTES) {
    const limitMB = Math.round(config.STORAGE_QUOTA_BYTES / 1024 / 1024);
    return `Storage quota exceeded (${limitMB}MB limit)`;
  }

  return null;
}

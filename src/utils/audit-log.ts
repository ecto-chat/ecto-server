import type { Db } from '../db/index.js';
import { auditLog } from '../db/schema/index.js';
import { generateUUIDv7 } from 'ecto-shared';

export async function insertAuditLog(
  d: Db,
  entry: {
    serverId: string;
    actorId: string;
    action: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
  },
) {
  await d.insert(auditLog).values({
    id: generateUUIDv7(),
    serverId: entry.serverId,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    details: entry.details ?? null,
  });
}

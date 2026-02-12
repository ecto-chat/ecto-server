import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    actorId: uuid('actor_id').notNull(),
    action: varchar('action', { length: 50 }).notNull(),
    targetType: varchar('target_type', { length: 20 }),
    targetId: uuid('target_id'),
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_audit_log_server_time').on(table.serverId, table.createdAt),
    index('idx_audit_log_actor').on(table.actorId),
  ],
);

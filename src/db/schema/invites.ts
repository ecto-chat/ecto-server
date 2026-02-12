import { pgTable, uuid, varchar, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    code: varchar('code', { length: 8 }).notNull().unique(),
    createdBy: uuid('created_by').notNull(),
    maxUses: integer('max_uses'),
    useCount: integer('use_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_invites_code').on(table.code),
    index('idx_invites_server').on(table.serverId),
  ],
);

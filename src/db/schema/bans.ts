import { pgTable, uuid, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const bans = pgTable(
  'bans',
  {
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    userId: uuid('user_id').notNull(),
    bannedBy: uuid('banned_by').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.serverId, table.userId),
    index('idx_bans_server').on(table.serverId),
  ],
);

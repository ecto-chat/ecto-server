import { pgTable, uuid, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const dmConversations = pgTable(
  'dm_conversations',
  {
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    userA: uuid('user_a').notNull(),
    userB: uuid('user_b').notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.serverId, table.userA, table.userB),
    index('idx_server_dm_conversations_user_a').on(table.serverId, table.userA, table.lastMessageAt),
    index('idx_server_dm_conversations_user_b').on(table.serverId, table.userB, table.lastMessageAt),
  ],
);

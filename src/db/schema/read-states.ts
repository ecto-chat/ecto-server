import { pgTable, uuid, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { channels } from './channels.js';

export const readStates = pgTable(
  'read_states',
  {
    userId: uuid('user_id').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastReadMessageId: uuid('last_read_message_id'),
    mentionCount: integer('mention_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.channelId] })],
);

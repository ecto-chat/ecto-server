import { pgTable, uuid, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { dmConversations } from './dm-conversations.js';

export const dmReadStates = pgTable(
  'dm_read_states',
  {
    userId: uuid('user_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => dmConversations.id, { onDelete: 'cascade' }),
    lastReadMessageId: uuid('last_read_message_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.conversationId] })],
);

import { pgTable, uuid, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';

export const activityItems = pgTable(
  'activity_items',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    type: varchar('type', { length: 20 }).notNull(),
    actorId: uuid('actor_id').notNull(),
    messageId: uuid('message_id'),
    channelId: uuid('channel_id'),
    conversationId: uuid('conversation_id'),
    contentPreview: text('content_preview'),
    emoji: varchar('emoji', { length: 64 }),
    read: boolean('read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_activity_user_created').on(table.userId, table.createdAt),
    index('idx_activity_user_read').on(table.userId, table.read),
  ],
);

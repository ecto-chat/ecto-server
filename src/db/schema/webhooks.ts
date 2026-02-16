import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    token: text('token').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_webhooks_channel').on(table.channelId),
    index('idx_webhooks_token').on(table.id, table.token),
  ],
);

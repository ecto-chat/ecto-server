import { pgTable, uuid, text, smallint, boolean, timestamp, index } from 'drizzle-orm/pg-core';

// NOTE: The `search_vector` tsvector column exists in the DB (migration 0002)
// but is intentionally excluded from the Drizzle schema. It is a GENERATED ALWAYS
// column used only via raw SQL in search.ts. Including it here would cause
// SELECT * queries to reference it, breaking on databases where the migration
// hasn't been applied yet.

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id').notNull(),
    authorId: uuid('author_id').notNull(),
    content: text('content'),
    type: smallint('type').notNull().default(0),
    replyTo: uuid('reply_to'),
    pinned: boolean('pinned').notNull().default(false),
    deleted: boolean('deleted').notNull().default(false),
    mentionEveryone: boolean('mention_everyone').notNull().default(false),
    mentionRoles: text('mention_roles').array(),
    mentionUsers: text('mention_users').array(),
    webhookId: uuid('webhook_id'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_messages_channel').on(table.channelId, table.id),
    index('idx_messages_pinned').on(table.channelId, table.pinned),
    index('idx_messages_reply').on(table.replyTo),
  ],
);

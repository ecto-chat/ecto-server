import { pgTable, uuid, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { messages } from './messages.js';

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 255 }).notNull(),
    url: varchar('url', { length: 512 }).notNull(),
    contentType: varchar('content_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_attachments_message').on(table.messageId)],
);

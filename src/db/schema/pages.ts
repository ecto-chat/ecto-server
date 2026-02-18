import { pgTable, uuid, text, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { channels } from './channels.js';

export const pageContents = pgTable('page_contents', {
  channelId: uuid('channel_id')
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  content: text('content').notNull().default(''),
  bannerUrl: varchar('banner_url', { length: 512 }),
  version: integer('version').notNull().default(1),
  editedBy: uuid('edited_by'),
  editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pageRevisions = pgTable(
  'page_revisions',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    version: integer('version').notNull(),
    editedBy: uuid('edited_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_page_revisions_channel').on(table.channelId, table.version),
  ],
);

import { pgTable, uuid, varchar, text, integer, timestamp, boolean, json, index } from 'drizzle-orm/pg-core';
import { channels } from './channels.js';

export const newsPosts = pgTable(
  'news_posts',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    subtitle: varchar('subtitle', { length: 500 }),
    heroImageUrl: varchar('hero_image_url', { length: 512 }),
    content: text('content').notNull(),
    commentCount: integer('comment_count').notNull().default(0),
    submittedToDiscovery: boolean('submitted_to_discovery').notNull().default(false),
    discoveryValidationErrors: json('discovery_validation_errors').$type<string[]>(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_news_posts_channel').on(table.channelId, table.publishedAt),
    index('idx_news_posts_published').on(table.publishedAt),
  ],
);

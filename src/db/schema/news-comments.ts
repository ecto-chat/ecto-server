import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { newsPosts } from './news-posts.js';

export const newsComments = pgTable(
  'news_comments',
  {
    id: uuid('id').primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => newsPosts.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull(),
    content: text('content').notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_news_comments_post').on(table.postId, table.id)],
);

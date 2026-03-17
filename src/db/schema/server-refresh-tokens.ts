import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { members } from './members.js';

export const serverRefreshTokens = pgTable(
  'server_refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_srt_member').on(table.memberId),
    index('idx_srt_token_hash').on(table.tokenHash),
    index('idx_srt_expires').on(table.expiresAt),
  ],
);

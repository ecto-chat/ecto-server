import { pgTable, uuid, varchar, boolean, timestamp, index, unique, integer } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    userId: uuid('user_id').notNull(),
    identityType: varchar('identity_type', { length: 10 }).notNull(),
    nickname: varchar('nickname', { length: 64 }),
    allowDms: boolean('allow_dms').notNull().default(true),
    tokenVersion: integer('token_version').notNull().default(0),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.serverId, table.userId),
    index('idx_members_server').on(table.serverId),
    index('idx_members_user').on(table.userId),
  ],
);

import { pgTable, uuid, varchar, bigint, index, unique } from 'drizzle-orm/pg-core';
import { channels } from './channels.js';

export const channelPermissionOverrides = pgTable(
  'channel_permission_overrides',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    targetType: varchar('target_type', { length: 10 }).notNull(),
    targetId: uuid('target_id').notNull(),
    allow: bigint('allow', { mode: 'number' }).notNull().default(0),
    deny: bigint('deny', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique().on(table.channelId, table.targetType, table.targetId),
    index('idx_channel_perms_channel').on(table.channelId),
  ],
);

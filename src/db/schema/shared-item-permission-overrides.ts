import { pgTable, uuid, varchar, bigint, index, unique } from 'drizzle-orm/pg-core';

export const sharedItemPermissionOverrides = pgTable(
  'shared_item_permission_overrides',
  {
    id: uuid('id').primaryKey(),
    itemType: varchar('item_type', { length: 10 }).notNull(),
    itemId: uuid('item_id').notNull(),
    targetType: varchar('target_type', { length: 10 }).notNull(),
    targetId: uuid('target_id').notNull(),
    allow: bigint('allow', { mode: 'number' }).notNull().default(0),
    deny: bigint('deny', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique().on(table.itemType, table.itemId, table.targetType, table.targetId),
    index('idx_shared_item_perms_item').on(table.itemType, table.itemId),
  ],
);

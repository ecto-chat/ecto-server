import { pgTable, uuid, varchar, bigint, index, unique } from 'drizzle-orm/pg-core';
import { categories } from './categories.js';

export const categoryPermissionOverrides = pgTable(
  'category_permission_overrides',
  {
    id: uuid('id').primaryKey(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    targetType: varchar('target_type', { length: 10 }).notNull(),
    targetId: uuid('target_id').notNull(),
    allow: bigint('allow', { mode: 'number' }).notNull().default(0),
    deny: bigint('deny', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique().on(table.categoryId, table.targetType, table.targetId),
    index('idx_category_perms_category').on(table.categoryId),
  ],
);

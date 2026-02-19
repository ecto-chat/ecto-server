import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const sharedFolders = pgTable(
  'shared_folders',
  {
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: varchar('name', { length: 255 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_shared_folders_server').on(table.serverId),
    index('idx_shared_folders_parent').on(table.parentId),
  ],
);

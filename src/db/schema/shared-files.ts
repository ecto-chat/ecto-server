import { pgTable, uuid, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';
import { sharedFolders } from './shared-folders.js';

export const sharedFiles = pgTable(
  'shared_files',
  {
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').references(() => sharedFolders.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 255 }).notNull(),
    url: varchar('url', { length: 512 }).notNull(),
    contentType: varchar('content_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_shared_files_server').on(table.serverId),
    index('idx_shared_files_folder').on(table.folderId),
  ],
);

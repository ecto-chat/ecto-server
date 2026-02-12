import { pgTable, uuid, varchar, bigint, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    name: varchar('name', { length: 100 }).notNull(),
    color: varchar('color', { length: 7 }),
    permissions: bigint('permissions', { mode: 'number' }).notNull().default(0),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_roles_server').on(table.serverId, table.position)],
);

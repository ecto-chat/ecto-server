import { pgTable, uuid, varchar, text, boolean, timestamp } from 'drizzle-orm/pg-core';

export const servers = pgTable('servers', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  iconUrl: varchar('icon_url', { length: 512 }),
  address: varchar('address', { length: 255 }),
  adminUserId: uuid('admin_user_id'),
  adminIdentityType: varchar('admin_identity_type', { length: 10 }).notNull().default('global'),
  centralConnected: boolean('central_connected').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

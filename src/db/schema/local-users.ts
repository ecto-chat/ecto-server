import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';

export const localUsers = pgTable('local_users', {
  id: uuid('id').primaryKey(),
  username: varchar('username', { length: 32 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 64 }),
  avatarUrl: varchar('avatar_url', { length: 512 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

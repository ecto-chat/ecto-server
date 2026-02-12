import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';

export const cachedProfiles = pgTable('cached_profiles', {
  userId: uuid('user_id').primaryKey(),
  username: varchar('username', { length: 32 }).notNull(),
  discriminator: varchar('discriminator', { length: 4 }).notNull(),
  displayName: varchar('display_name', { length: 64 }),
  avatarUrl: varchar('avatar_url', { length: 512 }),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

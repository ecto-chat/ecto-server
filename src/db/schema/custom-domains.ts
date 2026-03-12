import { pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const customDomains = pgTable('custom_domains', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => servers.id),
  domain: varchar('domain', { length: 255 }).notNull().unique(),
  status: varchar('status', { length: 20 }).notNull(),
});

import { pgTable, uuid, boolean, integer, timestamp } from 'drizzle-orm/pg-core';
import { servers } from './servers.js';

export const serverConfig = pgTable('server_config', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => servers.id),
  allowLocalAccounts: boolean('allow_local_accounts').notNull().default(true),
  requireInvite: boolean('require_invite').notNull().default(false),
  allowMemberDms: boolean('allow_member_dms').notNull().default(false),
  maxUploadSizeBytes: integer('max_upload_size_bytes').notNull().default(5242880),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

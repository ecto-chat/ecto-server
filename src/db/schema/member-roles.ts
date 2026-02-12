import { pgTable, uuid, primaryKey, index } from 'drizzle-orm/pg-core';
import { members } from './members.js';
import { roles } from './roles.js';

export const memberRoles = pgTable(
  'member_roles',
  {
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.roleId] }),
    index('idx_member_roles_role').on(table.roleId),
  ],
);

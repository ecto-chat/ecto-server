import { router, publicProcedure, protectedProcedure } from './init.js';
import { serverRouter } from './routers/server.js';
import { channelsRouter } from './routers/channels.js';
import { categoriesRouter } from './routers/categories.js';
import { messagesRouter } from './routers/messages.js';
import { membersRouter } from './routers/members.js';
import { rolesRouter } from './routers/roles.js';
import { bansRouter } from './routers/bans.js';
import { invitesRouter } from './routers/invites.js';
import { filesRouter } from './routers/files.js';
import { readStateRouter } from './routers/read-state.js';
import { auditLogRouter } from './routers/audit-log.js';
import { serverConfigRouter } from './routers/server-config.js';
import { serverDmsRouter } from './routers/server-dms.js';
import { webhooksRouter } from './routers/webhooks.js';
import { searchRouter } from './routers/search.js';

export { router, publicProcedure, protectedProcedure };

export const appRouter = router({
  server: serverRouter,
  channels: channelsRouter,
  categories: categoriesRouter,
  messages: messagesRouter,
  members: membersRouter,
  roles: rolesRouter,
  bans: bansRouter,
  invites: invitesRouter,
  files: filesRouter,
  read_state: readStateRouter,
  auditlog: auditLogRouter,
  serverConfig: serverConfigRouter,
  serverDms: serverDmsRouter,
  webhooks: webhooksRouter,
  search: searchRouter,
});

export type AppRouter = typeof appRouter;

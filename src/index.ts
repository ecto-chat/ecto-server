import 'dotenv/config';
import { createServer } from './http/server.js';
import { config } from './config/index.js';
import { getDb, db } from './db/index.js';
import { servers, serverConfig, roles } from './db/schema/index.js';
import { eq } from 'drizzle-orm';
import { generateUUIDv7, Permissions } from 'ecto-shared';
import { setServerId } from './trpc/context.js';
import { voiceManager } from './voice/index.js';

const DEFAULT_CHANNEL_PERMS =
  Permissions.READ_MESSAGES |
  Permissions.SEND_MESSAGES |
  Permissions.ATTACH_FILES |
  Permissions.EMBED_LINKS |
  Permissions.ADD_REACTIONS |
  Permissions.CONNECT_VOICE |
  Permissions.SPEAK_VOICE |
  Permissions.USE_VOICE_ACTIVITY |
  Permissions.USE_VIDEO |
  Permissions.SCREEN_SHARE |
  Permissions.CREATE_INVITES;

async function main() {
  // 1. Init database
  await getDb();
  const d = db();
  console.log('Database connected');

  // 2. Ensure server row exists
  const [existingServer] = await d.select().from(servers).limit(1);
  let serverId: string;

  if (existingServer) {
    serverId = existingServer.id;
  } else {
    serverId = generateUUIDv7();
    await d.insert(servers).values({
      id: serverId,
      name: 'My Ecto Server',
      address: config.SERVER_ADDRESS ?? null,
    });
    console.log('Created server row:', serverId);
  }

  setServerId(serverId);

  // 3. Ensure server_config row exists
  const [existingConfig] = await d
    .select()
    .from(serverConfig)
    .where(eq(serverConfig.serverId, serverId))
    .limit(1);

  if (!existingConfig) {
    await d.insert(serverConfig).values({ serverId });
    console.log('Created server_config row');
  }

  // 4. Ensure @everyone role exists
  const [existingDefault] = await d
    .select()
    .from(roles)
    .where(eq(roles.serverId, serverId))
    .limit(1);

  if (!existingDefault) {
    await d.insert(roles).values({
      id: generateUUIDv7(),
      serverId,
      name: '@everyone',
      permissions: DEFAULT_CHANNEL_PERMS,
      position: 0,
      isDefault: true,
    });
    console.log('Created @everyone role');
  }

  // 5. Initialize voice (mediasoup workers)
  await voiceManager.initialize();

  // 7. Start HTTP server
  const server = await createServer(config);
  server.listen(config.PORT, () => {
    console.log(`Ecto server listening on port ${config.PORT}`);
  });
}

main().catch(console.error);

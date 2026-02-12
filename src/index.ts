import 'dotenv/config';
import { createServer } from './http/server.js';
import { config } from './config/index.js';

async function main() {
  const server = await createServer(config);
  server.listen(config.PORT, () => {
    console.log(`Ecto server listening on port ${config.PORT}`);
  });
}

main().catch(console.error);

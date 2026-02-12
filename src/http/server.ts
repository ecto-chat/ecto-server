import http from 'node:http';
import type { Config } from '../config/index.js';

export async function createServer(_config: Config) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  // TODO: Attach tRPC HTTP adapter
  // TODO: Attach WebSocket servers (main, notify)
  // TODO: Attach file upload handler

  return server;
}

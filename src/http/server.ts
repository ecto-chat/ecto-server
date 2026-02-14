import http from 'node:http';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import type { Config } from '../config/index.js';
import { appRouter } from '../trpc/router.js';
import { createContext } from '../trpc/context.js';
import { handleFileUpload } from './file-upload.js';
import { handleIconUpload } from './icon-upload.js';
import { handleFileServe } from './file-serve.js';
import { setupMainWebSocket } from '../ws/main-ws.js';
import { setupNotifyWebSocket } from '../ws/notify-ws.js';

export async function createServer(_config: Config) {
  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext,
    basePath: '/trpc/',
  });

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Icon upload
    if (url.pathname === '/upload/icon' && req.method === 'POST') {
      await handleIconUpload(req, res);
      return;
    }

    // File upload
    if (url.pathname === '/upload' && req.method === 'POST') {
      await handleFileUpload(req, res);
      return;
    }

    // File serving
    if (url.pathname.startsWith('/files/')) {
      await handleFileServe(req, res);
      return;
    }

    // tRPC handler
    trpcHandler(req, res);
  });

  // WebSocket upgrade
  const mainWss = setupMainWebSocket();
  const notifyWss = setupNotifyWebSocket();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/ws') {
      mainWss.handleUpgrade(req, socket, head, (ws) => {
        mainWss.emit('connection', ws, req);
      });
    } else if (url.pathname === '/notify') {
      notifyWss.handleUpgrade(req, socket, head, (ws) => {
        notifyWss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  return server;
}

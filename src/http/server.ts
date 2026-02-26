import http from 'node:http';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { config } from '../config/index.js';
import type { Config } from '../config/index.js';
import { appRouter } from '../trpc/router.js';
import { createContext } from '../trpc/context.js';
import { handleFileUpload } from './file-upload.js';
import { handleDmFileUpload } from './dm-file-upload.js';
import { handleSharedFileUpload } from './shared-file-upload.js';
import { handleIconUpload, handleBannerUpload, handlePageBannerUpload } from './icon-upload.js';
import { handleFileServe } from './file-serve.js';
import { handleWebhookExecute } from './webhook-execute.js';
import { setupMainWebSocket } from '../ws/main-ws.js';
import { setupNotifyWebSocket } from '../ws/notify-ws.js';

export async function createServer(_config: Config) {
  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext,
    basePath: '/trpc/',
    onError({ error, path }) {
      console.error(`[trpc] ${path}:`, error.message, error.cause ?? '');
    },
  });

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // HEAD at root — used by client for server health probes
    if (req.method === 'HEAD' && (req.url === '/' || req.url === '')) {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Browser redirect — send browsers visiting the server URL to the client app
    if (req.method === 'GET') {
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/html')) {
        const serverAddr = config.SERVER_ADDRESS ?? req.headers.host ?? '';
        const clientBase = config.CLIENT_URL.replace(/\/+$/, '');

        // GET /invite/:code → redirect with invite param
        const inviteMatch = url.pathname.match(/^\/invite\/([^/]+)$/);
        if (inviteMatch) {
          const code = encodeURIComponent(inviteMatch[1]!);
          res.writeHead(302, { Location: `${clientBase}?join=${encodeURIComponent(serverAddr)}&invite=${code}` });
          res.end();
          return;
        }

        // GET / → redirect to client with join param
        if (url.pathname === '/' || url.pathname === '') {
          res.writeHead(302, { Location: `${clientBase}?join=${encodeURIComponent(serverAddr)}` });
          res.end();
          return;
        }
      }
    }

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

    // Banner upload
    if (url.pathname === '/upload/banner' && req.method === 'POST') {
      await handleBannerUpload(req, res);
      return;
    }

    // Page banner upload
    if (url.pathname.startsWith('/upload/page-banner/') && req.method === 'POST') {
      await handlePageBannerUpload(req, res, url.pathname.split('/')[3] ?? '');
      return;
    }

    // Shared file upload
    if (url.pathname === '/upload/shared' && req.method === 'POST') {
      await handleSharedFileUpload(req, res);
      return;
    }

    // DM file upload
    if (url.pathname === '/upload/dm' && req.method === 'POST') {
      await handleDmFileUpload(req, res);
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

    // Webhook execution
    if (url.pathname.startsWith('/webhooks/') && req.method === 'POST') {
      await handleWebhookExecute(req, res, url);
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

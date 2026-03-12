import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { eq } from 'drizzle-orm';
import { config } from '../config/index.js';
import type { Config } from '../config/index.js';
import { appRouter } from '../trpc/router.js';
import { createContext } from '../trpc/context.js';
import { handleFileUpload } from './file-upload.js';
import { handleDmFileUpload } from './dm-file-upload.js';
import { handleSharedFileUpload } from './shared-file-upload.js';
import { handleIconUpload, handleBannerUpload, handlePageBannerUpload, handleNewsHeroUpload } from './icon-upload.js';
import { handleFileServe } from './file-serve.js';
import { handleWebhookExecute } from './webhook-execute.js';
import { handleLinkUnfurl } from './link-unfurl.js';
import { handleOgImage, renderOgHtml, getServerInfo } from './og-image.js';
import { setupMainWebSocket } from '../ws/main-ws.js';
import { setupNotifyWebSocket } from '../ws/notify-ws.js';
import { db } from '../db/index.js';
import { serverConfig, servers } from '../db/schema/index.js';
import { formatServer } from '../utils/format.js';
import { readBody } from '../utils/http.js';
import { ServerWsEvents } from 'ecto-shared';
import { eventDispatcher } from '../ws/event-dispatcher.js';

export async function createServer(_config: Config) {
  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext,
    basePath: '/trpc/',
    onError({ error, path }) {
      console.error(`[trpc] ${path}:`, error.message, error.cause ?? '');
    },
  });

  const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
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

    // OG image endpoint
    if (url.pathname === '/og-image' && req.method === 'GET') {
      await handleOgImage(req, res);
      return;
    }

    // Browser visits — serve HTML with OG tags + instant meta-refresh redirect
    if (req.method === 'GET') {
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/html')) {
        const serverAddr = config.SERVER_ADDRESS ?? req.headers.host ?? '';
        const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        // Use the host header for OG image URL (includes port), fall back to SERVER_ADDRESS
        const hostWithPort = req.headers.host ?? serverAddr;
        const serverUrl = `${proto}://${hostWithPort}`;
        const clientBase = config.CLIENT_URL.replace(/\/+$/, '');

        // GET /invite/:code → OG page for invite
        const inviteMatch = url.pathname.match(/^\/invite\/([^/]+)$/);
        if (inviteMatch) {
          const code = encodeURIComponent(inviteMatch[1]!);
          const info = await getServerInfo(req.headers['x-server-address'] as string | undefined);
          const serverName = info?.name ?? 'a server';
          const html = renderOgHtml({
            title: `Join ${serverName} on Ecto`,
            description: info?.description ?? 'You\'ve been invited to join a server on Ecto.',
            imageUrl: `${serverUrl}/og-image`,
            pageUrl: `${serverUrl}/invite/${code}`,
            redirectUrl: `${clientBase}?join=${encodeURIComponent(serverAddr)}&invite=${code}`,
          });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        // GET / → OG page for server
        if (url.pathname === '/' || url.pathname === '') {
          const info = await getServerInfo(req.headers['x-server-address'] as string | undefined);
          const serverName = info?.name ?? 'a server';
          const html = renderOgHtml({
            title: `Join ${serverName} on Ecto`,
            description: info?.description ?? 'Click to join the server on Ecto.',
            imageUrl: `${serverUrl}/og-image`,
            pageUrl: serverUrl,
            redirectUrl: `${clientBase}?join=${encodeURIComponent(serverAddr)}`,
          });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
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

    // News hero image upload
    if (url.pathname.startsWith('/upload/news-hero/') && req.method === 'POST') {
      await handleNewsHeroUpload(req, res, url.pathname.split('/')[3] ?? '');
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

    // Link unfurl / OG metadata proxy
    if (url.pathname === '/api/unfurl' && req.method === 'GET') {
      await handleLinkUnfurl(req, res);
      return;
    }

    // Discovery status push from central (approval/rejection)
    if (url.pathname === '/api/discovery-status' && req.method === 'POST') {
      try {
        if (!config.CENTRAL_SYNC_KEY) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Discovery sync not configured' }));
          return;
        }
        const body = await readBody(req);

        // Verify HMAC signature (central signs with shared secret, never sends it)
        const sigHeader = req.headers['x-signature'];
        const tsHeader = req.headers['x-timestamp'];
        if (!sigHeader || !tsHeader) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing signature' }));
          return;
        }
        const ts = Array.isArray(tsHeader) ? tsHeader[0]! : tsHeader;
        const tsNum = Number(ts);
        // Reject if timestamp is invalid or more than 5 minutes old
        if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Timestamp expired' }));
          return;
        }
        const expected = createHmac('sha256', config.CENTRAL_SYNC_KEY)
          .update(`${ts}.${body}`)
          .digest('hex');
        const sig = Array.isArray(sigHeader) ? sigHeader[0]! : sigHeader;
        const sigBuf = Buffer.from(sig);
        const expectedBuf = Buffer.from(expected);
        if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }

        const data = JSON.parse(body) as { approved?: boolean };
        const approved = data.approved ?? false;

        const d = db();

        // Resolve target server: use x-server-address (gateway multi-tenant) or fall back to single server
        const serverAddress = req.headers['x-server-address'];
        let serverRow;
        if (serverAddress) {
          const addr = Array.isArray(serverAddress) ? serverAddress[0]! : serverAddress;
          [serverRow] = await d.select().from(servers).where(eq(servers.address, addr)).limit(1);
        } else {
          [serverRow] = await d.select().from(servers).limit(1);
        }

        if (serverRow) {
          await d.update(serverConfig).set({ discoveryApproved: approved, updatedAt: new Date() }).where(eq(serverConfig.serverId, serverRow.id));
          const [cfg] = await d.select().from(serverConfig).where(eq(serverConfig.serverId, serverRow.id)).limit(1);
          eventDispatcher.dispatchToServer(serverRow.id, ServerWsEvents.SERVER_UPDATE, formatServer(serverRow, cfg));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    // tRPC handler
    trpcHandler(req, res);
  };

  // Create HTTP or HTTPS server depending on TLS config
  const server = _config.TLS_CERT_PATH && _config.TLS_KEY_PATH
    ? https.createServer(
        { cert: fs.readFileSync(_config.TLS_CERT_PATH), key: fs.readFileSync(_config.TLS_KEY_PATH) },
        requestHandler,
      )
    : http.createServer(requestHandler);

  // When TLS is enabled, create a plain HTTP server for internal/private-network traffic
  let internalHttpServer: http.Server | undefined;
  if (_config.TLS_CERT_PATH && _config.TLS_KEY_PATH && _config.INTERNAL_HTTP_PORT) {
    internalHttpServer = http.createServer(requestHandler);
    internalHttpServer.listen(_config.INTERNAL_HTTP_PORT, () => {
      console.log(`Internal HTTP listening on port ${_config.INTERNAL_HTTP_PORT}`);
    });
  }

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

  return Object.assign(server, { internalHttpServer });
}

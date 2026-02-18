import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { verifyToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { servers, channels, pageContents } from '../db/schema/index.js';
import { config } from '../config/index.js';
import { generateUUIDv7 } from 'ecto-shared';
import { eq, and } from 'drizzle-orm';
import { getServerId } from '../trpc/context.js';
import { requirePermission } from '../utils/permission-context.js';
import { Permissions } from 'ecto-shared';
import { parseMultipart } from './multipart.js';
import { eventDispatcher } from '../ws/event-dispatcher.js';

export async function handleBannerUpload(req: IncomingMessage, res: ServerResponse) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const user = await verifyToken(authHeader.slice(7));
    const d = db();
    const serverId = getServerId();

    await requirePermission(d, serverId, user.id, Permissions.MANAGE_SERVER);

    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return;
    }

    const { file } = await parseMultipart(req, boundaryMatch[1]!);
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file provided' }));
      return;
    }

    if (!file.contentType.startsWith('image/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File must be an image' }));
      return;
    }

    // Max 800KB for banners
    if (file.data.length > 800 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Banner must be under 800KB' }));
      return;
    }

    const bannerId = generateUUIDv7();
    const ext = path.extname(file.filename) || '.png';
    const bannerFilename = `banner-${bannerId}${ext}`;
    const dir = path.join(config.UPLOAD_DIR, serverId, 'banners');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, bannerFilename), file.data);

    const baseUrl = `http://${req.headers.host ?? `localhost:${config.PORT}`}`;
    const bannerUrl = `${baseUrl}/files/${serverId}/banners/${bannerFilename}`;

    await d.update(servers).set({ bannerUrl, updatedAt: new Date() }).where(eq(servers.id, serverId));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ banner_url: bannerUrl }));
  } catch (err) {
    console.error('Banner upload error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload failed' }));
  }
}

export async function handlePageBannerUpload(req: IncomingMessage, res: ServerResponse, channelId: string) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const user = await verifyToken(authHeader.slice(7));
    const d = db();
    const serverId = getServerId();

    // Verify channel exists and is a page channel
    const [ch] = await d
      .select({ type: channels.type })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.serverId, serverId)))
      .limit(1);

    if (!ch || ch.type !== 'page') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Channel is not a page channel' }));
      return;
    }

    await requirePermission(d, serverId, user.id, Permissions.EDIT_PAGES, channelId);

    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return;
    }

    const { file } = await parseMultipart(req, boundaryMatch[1]!);
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file provided' }));
      return;
    }

    if (!file.contentType.startsWith('image/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File must be an image' }));
      return;
    }

    if (file.data.length > 800 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Banner must be under 800KB' }));
      return;
    }

    const bannerId = generateUUIDv7();
    const ext = path.extname(file.filename) || '.png';
    const bannerFilename = `page-banner-${bannerId}${ext}`;
    const dir = path.join(config.UPLOAD_DIR, serverId, 'page-banners');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, bannerFilename), file.data);

    const baseUrl = `http://${req.headers.host ?? `localhost:${config.PORT}`}`;
    const bannerUrl = `${baseUrl}/files/${serverId}/page-banners/${bannerFilename}`;

    await d.update(pageContents).set({ bannerUrl }).where(eq(pageContents.channelId, channelId));

    // Broadcast page.update so other clients see the banner change
    const [updated] = await d
      .select()
      .from(pageContents)
      .where(eq(pageContents.channelId, channelId))
      .limit(1);

    if (updated) {
      eventDispatcher.dispatchToChannel(channelId, 'page.update', {
        channel_id: updated.channelId,
        content: updated.content,
        banner_url: updated.bannerUrl ?? null,
        version: updated.version,
        edited_by: updated.editedBy,
        edited_at: updated.editedAt.toISOString(),
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ banner_url: bannerUrl }));
  } catch (err) {
    console.error('Page banner upload error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload failed' }));
  }
}

export async function handleIconUpload(req: IncomingMessage, res: ServerResponse) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const user = await verifyToken(authHeader.slice(7));
    const d = db();
    const serverId = getServerId();

    await requirePermission(d, serverId, user.id, Permissions.MANAGE_SERVER);

    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return;
    }

    const { file } = await parseMultipart(req, boundaryMatch[1]!);
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file provided' }));
      return;
    }

    // Validate it's an image
    if (!file.contentType.startsWith('image/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File must be an image' }));
      return;
    }

    // Max 2MB for icons
    if (file.data.length > 2 * 1024 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Icon must be under 2MB' }));
      return;
    }

    // Save to disk
    const iconId = generateUUIDv7();
    const ext = path.extname(file.filename) || '.png';
    const iconFilename = `icon-${iconId}${ext}`;
    const dir = path.join(config.UPLOAD_DIR, serverId, 'icons');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, iconFilename), file.data);

    const baseUrl = `http://${req.headers.host ?? `localhost:${config.PORT}`}`;
    const iconUrl = `${baseUrl}/files/${serverId}/icons/${iconFilename}`;

    // Update server row
    await d.update(servers).set({ iconUrl, updatedAt: new Date() }).where(eq(servers.id, serverId));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ icon_url: iconUrl }));
  } catch (err) {
    console.error('Icon upload error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload failed' }));
  }
}

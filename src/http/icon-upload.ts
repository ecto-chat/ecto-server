import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { servers, channels, pageContents } from '../db/schema/index.js';
import { generateUUIDv7 } from 'ecto-shared';
import { eq, and } from 'drizzle-orm';
import { resolveServerId } from '../trpc/context.js';
import { requirePermission } from '../utils/permission-context.js';
import { Permissions } from 'ecto-shared';
import { parseMultipart } from './multipart.js';
import { eventDispatcher } from '../ws/event-dispatcher.js';
import { fileStorage } from '../services/file-storage.js';

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
    const serverId = await resolveServerId(req);

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
    const ext = file.filename.includes('.') ? file.filename.slice(file.filename.lastIndexOf('.')) : '.png';
    const bannerFilename = `banner-${bannerId}${ext}`;
    const storageKey = `${serverId}/banners/${bannerFilename}`;
    const savedUrl = await fileStorage.save(storageKey, file.data, file.contentType);

    // If storage returns a relative URL, make it absolute for the DB
    const bannerUrl = savedUrl.startsWith('http')
      ? savedUrl
      : `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}${savedUrl}`;

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
    const serverId = await resolveServerId(req);

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
    const ext = file.filename.includes('.') ? file.filename.slice(file.filename.lastIndexOf('.')) : '.png';
    const bannerFilename = `page-banner-${bannerId}${ext}`;
    const storageKey = `${serverId}/page-banners/${bannerFilename}`;
    const savedUrl = await fileStorage.save(storageKey, file.data, file.contentType);

    const bannerUrl = savedUrl.startsWith('http')
      ? savedUrl
      : `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}${savedUrl}`;

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
    const serverId = await resolveServerId(req);

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

    // Save via storage backend
    const iconId = generateUUIDv7();
    const ext = file.filename.includes('.') ? file.filename.slice(file.filename.lastIndexOf('.')) : '.png';
    const iconFilename = `icon-${iconId}${ext}`;
    const storageKey = `${serverId}/icons/${iconFilename}`;
    const savedUrl = await fileStorage.save(storageKey, file.data, file.contentType);

    const iconUrl = savedUrl.startsWith('http')
      ? savedUrl
      : `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}${savedUrl}`;

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

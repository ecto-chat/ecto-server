import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { verifyToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { servers } from '../db/schema/index.js';
import { config } from '../config/index.js';
import { generateUUIDv7 } from 'ecto-shared';
import { eq } from 'drizzle-orm';
import { getServerId } from '../trpc/context.js';
import { requirePermission } from '../utils/permission-context.js';
import { Permissions } from 'ecto-shared';
import { parseMultipart } from './multipart.js';

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

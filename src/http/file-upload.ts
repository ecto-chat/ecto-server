import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { verifyToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { attachments, channels, serverConfig } from '../db/schema/index.js';
import { config } from '../config/index.js';
import { generateUUIDv7 } from 'ecto-shared';
import { eq } from 'drizzle-orm';
import { requirePermission } from '../utils/permission-context.js';
import { Permissions } from 'ecto-shared';
import { parseMultipart } from './multipart.js';

export async function handleFileUpload(req: IncomingMessage, res: ServerResponse) {
  try {
    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const user = await verifyToken(authHeader.slice(7));
    const d = db();

    // Parse multipart
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return;
    }

    const { fields, file } = await parseMultipart(req, boundaryMatch[1]!);
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file provided' }));
      return;
    }

    const channelId = fields['channel_id'];
    if (!channelId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'channel_id required' }));
      return;
    }

    // Verify channel exists
    const [channel] = await d.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Channel not found' }));
      return;
    }

    // Check ATTACH_FILES permission
    await requirePermission(d, channel.serverId, user.id, Permissions.ATTACH_FILES, channelId);

    // Check file size
    const [sConfig] = await d
      .select()
      .from(serverConfig)
      .where(eq(serverConfig.serverId, channel.serverId))
      .limit(1);
    const maxSize = sConfig?.maxUploadSizeBytes ?? 5242880;
    if (file.data.length > maxSize) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File too large' }));
      return;
    }

    // Save to disk
    const attachmentId = generateUUIDv7();
    const dir = path.join(config.UPLOAD_DIR, channel.serverId, channelId, attachmentId);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, file.filename);
    await fs.promises.writeFile(filePath, file.data);

    // Insert attachment row (message_id=null, linked when message sent)
    const url = `/files/${attachmentId}/${encodeURIComponent(file.filename)}`;
    await d.insert(attachments).values({
      id: attachmentId,
      messageId: null,
      filename: file.filename,
      url,
      contentType: file.contentType,
      sizeBytes: file.data.length,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: attachmentId,
        filename: file.filename,
        url,
        content_type: file.contentType,
        size_bytes: file.data.length,
      }),
    );
  } catch (err) {
    console.error('File upload error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload failed' }));
  }
}

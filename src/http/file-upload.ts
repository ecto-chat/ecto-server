import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import path from 'node:path';
import { verifyToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { attachments, members, channels, serverConfig } from '../db/schema/index.js';
import { config } from '../config/index.js';
import { generateUUIDv7 } from 'ecto-shared';
import { eq, and } from 'drizzle-orm';
import { requirePermission } from '../utils/permission-context.js';
import { Permissions } from 'ecto-shared';

function parseMultipart(
  req: IncomingMessage,
  boundary: string,
): Promise<{ fields: Record<string, string>; file?: { filename: string; contentType: string; data: Buffer } }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const bodyStr = body.toString('latin1');
      const parts = bodyStr.split(`--${boundary}`).filter((p) => p && p !== '--\r\n' && p !== '--');

      const fields: Record<string, string> = {};
      let file: { filename: string; contentType: string; data: Buffer } | undefined;

      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headers = part.slice(0, headerEnd);
        const content = part.slice(headerEnd + 4, part.endsWith('\r\n') ? part.length - 2 : part.length);

        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const ctMatch = headers.match(/Content-Type:\s*(.+)/i);

        if (filenameMatch && nameMatch) {
          const start = body.indexOf(Buffer.from(content, 'latin1'));
          file = {
            filename: filenameMatch[1]!,
            contentType: ctMatch?.[1]?.trim() ?? 'application/octet-stream',
            data: body.subarray(start, start + Buffer.byteLength(content, 'latin1')),
          };
        } else if (nameMatch) {
          fields[nameMatch[1]!] = content.trim();
        }
      }
      resolve({ fields, file });
    });
    req.on('error', reject);
  });
}

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

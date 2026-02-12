import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { config } from '../config/index.js';

export async function handleFileServe(req: IncomingMessage, res: ServerResponse) {
  try {
    // Parse /files/{attachmentId}/{filename}
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);
    // parts: ['files', attachmentId, filename]
    if (parts.length < 3) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const attachmentId = parts[1]!;
    const d = db();

    const [attachment] = await d
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);

    if (!attachment) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Attachment not found' }));
      return;
    }

    // Find file on disk — search upload dirs
    const globPattern = path.join(config.UPLOAD_DIR, '**', attachmentId, attachment.filename);
    // Simple: walk the upload dir to find the file
    const searchDirs = await findAttachmentFile(attachmentId, attachment.filename);
    if (!searchDirs) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found on disk' }));
      return;
    }

    const stat = await fs.promises.stat(searchDirs);
    res.writeHead(200, {
      'Content-Type': attachment.contentType,
      'Content-Length': stat.size.toString(),
      'Content-Disposition': `inline; filename="${attachment.filename}"`,
      'Cache-Control': 'public, max-age=86400',
    });

    const stream = fs.createReadStream(searchDirs);
    stream.pipe(res);
  } catch (err) {
    console.error('File serve error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error' }));
    }
  }
}

async function findAttachmentFile(
  attachmentId: string,
  filename: string,
): Promise<string | null> {
  const baseDir = config.UPLOAD_DIR;
  try {
    const serverDirs = await fs.promises.readdir(baseDir);
    for (const serverDir of serverDirs) {
      const channelDirs = await fs.promises.readdir(path.join(baseDir, serverDir)).catch(() => []);
      for (const channelDir of channelDirs) {
        const filePath = path.join(baseDir, serverDir, channelDir, attachmentId, filename);
        try {
          await fs.promises.access(filePath);
          return filePath;
        } catch {
          // Not here
        }
      }
    }
  } catch {
    // Upload dir doesn't exist yet
  }
  return null;
}

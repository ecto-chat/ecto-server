import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyToken } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { attachments, serverConfig } from '../db/schema/index.js';
import { generateUUIDv7 } from 'ecto-shared';
import { eq } from 'drizzle-orm';
import { parseMultipart } from './multipart.js';
import { checkStorageQuota } from '../services/storage-quota.js';
import { resolveServerId } from '../trpc/context.js';
import { fileStorage } from '../services/file-storage.js';

export async function handleDmFileUpload(req: IncomingMessage, res: ServerResponse) {
  try {
    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    await verifyToken(authHeader.slice(7));
    const d = db();
    const serverId = await resolveServerId(req);

    // Parse multipart
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- regex match guarantees capture group
    const { file } = await parseMultipart(req, boundaryMatch[1]!);
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file provided' }));
      return;
    }

    // Check file size
    const [sConfig] = await d
      .select()
      .from(serverConfig)
      .where(eq(serverConfig.serverId, serverId))
      .limit(1);
    const maxSize = sConfig?.maxUploadSizeBytes ?? 5242880;
    if (file.data.length > maxSize) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File too large' }));
      return;
    }

    // Check server-wide storage quota (images exempt)
    const quotaError = await checkStorageQuota(serverId, file.data.length, file.contentType);
    if (quotaError) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: quotaError }));
      return;
    }

    // Save file via storage backend
    const attachmentId = generateUUIDv7();
    const storageKey = `${serverId}/dm/${attachmentId}/${file.filename}`;
    const url = await fileStorage.save(storageKey, file.data, file.contentType);
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
    console.error('DM file upload error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload failed' }));
    }
  }
}
